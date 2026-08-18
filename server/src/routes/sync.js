import { Router } from 'express';
import { q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale, createReturn } from '../services/sales.js';
import { createClient } from '../services/clients.js';

export const syncRouter = Router();
syncRouter.use(requireAuth, requirePerm('pos'));

// Обработчики операций из офлайн-очереди. Каждая операция идемпотентна
// (по client_uuid внутри самой операции), поэтому повторная отправка безопасна.
// Продажи/возвраты дедуплицируются по sales.client_uuid, прочие — через sync_ops.
const HANDLERS = {
  sale: (user, payload) => createSale(user, payload),
  return: (user, payload) => createReturn(user, payload),
  client: (user, payload) => createClient(payload).then((r) => r.client),
};

/**
 * POST /api/sync
 * body: { ops: [{ client_uuid, kind, payload }] }
 * Возвращает per-op результат, чтобы клиент вычистил из очереди успешные.
 */
syncRouter.post(
  '/',
  ah(async (req, res) => {
    const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
    if (ops.length === 0) return res.json({ results: [] });

    const results = [];
    for (const op of ops) {
      const clientUuid = op.client_uuid || op.payload?.client_uuid;
      try {
        // Уже обработанная не-продажная операция?
        if (clientUuid) {
          const done = await q1('SELECT result FROM sync_ops WHERE client_uuid=$1', [clientUuid]);
          if (done) {
            results.push({ client_uuid: clientUuid, status: 'ok', duplicate: true, result: done.result });
            continue;
          }
        }
        const handler = HANDLERS[op.kind];
        if (!handler) throw new Error(`Неизвестный тип операции: ${op.kind}`);

        // Прокидываем client_uuid внутрь payload для идемпотентности продаж/возвратов
        const payload = { ...op.payload, client_uuid: clientUuid };
        const result = await handler(req.user, payload);

        // Фиксируем факт обработки для не-идемпотентных на уровне БД операций
        if (clientUuid && op.kind !== 'sale' && op.kind !== 'return') {
          await q1('INSERT INTO sync_ops (client_uuid, kind, result) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
            clientUuid,
            op.kind,
            JSON.stringify(result),
          ]);
        }
        results.push({ client_uuid: clientUuid, status: 'ok', result });
      } catch (err) {
        // Ошибка одной операции не роняет всю партию
        results.push({ client_uuid: clientUuid, status: 'error', error: err.message });
      }
    }
    await audit(req, 'sync.batch', { meta: { count: ops.length } });
    res.json({ results });
  })
);

// GET /api/sync/pull?since= — свежие данные для обновления офлайн-кэша
syncRouter.get(
  '/pull',
  ah(async (req, res) => {
    const [catalog, cashback] = await Promise.all([
      import('../db.js').then(({ q }) =>
        Promise.all([
          q('SELECT * FROM product_groups ORDER BY sort, id'),
          q('SELECT * FROM products WHERE is_active ORDER BY sort, id'),
        ])
      ),
      q1(`SELECT value FROM settings WHERE key='cashback'`),
    ]);
    res.json({
      groups: catalog[0],
      products: catalog[1],
      cashback: Number(cashback?.value ?? 5),
      server_time: new Date().toISOString(),
    });
  })
);
