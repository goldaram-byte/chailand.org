import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createClient } from '../services/clients.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth, requirePerm('clients'));

// GET /api/clients — поиск + фильтры
//   search   — по имени/телефону/карте
//   app      — 1|0 установлено ли приложение
//   min_bonus — минимум бонусов
//   min_buys  — минимум покупок
//   bday_days — у ребёнка ДР в ближайшие N дней
//   referral  — invited (кто-то пришёл по его коду) | referred (сам пришёл по коду)
clientsRouter.get(
  '/',
  ah(async (req, res) => {
    const { search, app, min_bonus, min_buys, bday_days, referral } = req.query;
    const where = [];
    const p = [];
    const add = (v) => { p.push(v); return '$' + p.length; };

    if (search && search.trim()) {
      const ph = add(`%${search.trim()}%`);
      where.push(`(c.full_name ILIKE ${ph} OR c.phone ILIKE ${ph} OR c.card_no ILIKE ${ph})`);
    }
    if (app === '1' || app === '0') where.push(`c.app_installed = ${add(app === '1')}`);
    if (min_bonus) where.push(`c.bonus >= ${add(Number(min_bonus))}`);
    if (min_buys) where.push(`COALESCE(sc.buys,0) >= ${add(Number(min_buys))}`);
    if (bday_days) where.push(`bd.next_days <= ${add(Number(bday_days))}`);
    if (referral === 'invited') where.push(`EXISTS (SELECT 1 FROM clients r WHERE r.referred_by = c.id)`);
    if (referral === 'referred') where.push(`c.referred_by IS NOT NULL`);

    const rows = await q(
      `SELECT c.*,
              COALESCE(sc.buys,0)::int AS buys,
              sc.last_buy,
              bd.next_days AS kid_bday_in,
              COALESCE(pa.n,0)::int AS active_passes
         FROM clients c
         LEFT JOIN (SELECT client_id, count(*) AS buys, max(created_at) AS last_buy
                      FROM sales WHERE is_return=false AND client_id IS NOT NULL GROUP BY client_id) sc
                ON sc.client_id = c.id
         LEFT JOIN (SELECT client_id,
                           min(((date_part('doy',birth_date)::int - date_part('doy',current_date)::int + 366) % 366)) AS next_days
                      FROM client_kids WHERE birth_date IS NOT NULL GROUP BY client_id) bd
                ON bd.client_id = c.id
         LEFT JOIN (SELECT client_id, count(*) AS n FROM passes
                     WHERE status='active' AND valid_to >= current_date GROUP BY client_id) pa
                ON pa.client_id = c.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      p
    );
    res.json(rows);
  })
);

// GET /api/clients/:id — карточка с детьми, историей покупок и бонусами
clientsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const client = await q1('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    const [kids, loyalty, sales] = await Promise.all([
      q('SELECT * FROM client_kids WHERE client_id=$1 ORDER BY birth_date', [client.id]),
      q('SELECT * FROM loyalty_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50', [client.id]),
      q(
        `SELECT s.id, s.total, s.method, s.bonus_earned, s.bonus_used, s.is_return, s.created_at,
                COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty,'price',i.price))
                         FILTER (WHERE i.id IS NOT NULL), '[]') AS items
           FROM sales s LEFT JOIN sale_items i ON i.sale_id = s.id
          WHERE s.client_id=$1
          GROUP BY s.id ORDER BY s.created_at DESC LIMIT 50`,
        [client.id]
      ),
    ]);
    const invited = await q1('SELECT count(*)::int AS c FROM clients WHERE referred_by=$1', [client.id]);
    const referrer = client.referred_by
      ? await q1('SELECT full_name FROM clients WHERE id=$1', [client.referred_by])
      : null;
    res.json({
      ...client,
      kids,
      loyalty,
      history: sales,
      invited_count: invited.c,
      referrer_name: referrer?.full_name || null,
    });
  })
);

// POST /api/clients
clientsRouter.post(
  '/',
  ah(async (req, res) => {
    const { client, referrer } = await createClient(req.body || {});
    await audit(req, 'client.create', { entity: 'client', entityId: client.id, meta: { referrer: referrer?.id } });
    res.json(client);
  })
);

// PUT /api/clients/:id
clientsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const { full_name, phone, app_installed, note } = req.body || {};
    const row = await q1(
      `UPDATE clients SET
         full_name = COALESCE($2, full_name),
         phone = COALESCE($3, phone),
         app_installed = COALESCE($4, app_installed),
         note = COALESCE($5, note)
       WHERE id=$1 RETURNING *`,
      [req.params.id, full_name, phone, app_installed, note]
    );
    res.json(row);
  })
);

// DELETE /api/clients/:id — удалить клиента из базы (только владелец/администратор).
// История продаж сохраняется (продажи отвязываются от клиента), дети и бонусные
// операции удаляются вместе с клиентом.
clientsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Удалять клиентов может только владелец или администратор' });
    }
    const client = await q1('SELECT id, full_name FROM clients WHERE id=$1', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    await tx(async ({ q: cq }) => {
      await cq('UPDATE sales SET client_id=NULL WHERE client_id=$1', [client.id]);
      await cq('UPDATE leads SET client_id=NULL WHERE client_id=$1', [client.id]);
      await cq('UPDATE clients SET referred_by=NULL WHERE referred_by=$1', [client.id]);
      await cq('DELETE FROM clients WHERE id=$1', [client.id]); // дети и лояльность — каскадом
    });
    await audit(req, 'client.delete', { entity: 'client', entityId: client.id, meta: { name: client.full_name } });
    res.json({ ok: true });
  })
);

// POST /api/clients/:id/kids
clientsRouter.post(
  '/:id/kids',
  ah(async (req, res) => {
    const { name, birth_date } = req.body || {};
    const row = await q1('INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,$2,$3) RETURNING *', [
      req.params.id,
      name,
      birth_date || null,
    ]);
    res.json(row);
  })
);

clientsRouter.delete(
  '/:id/kids/:kidId',
  ah(async (req, res) => {
    await q('DELETE FROM client_kids WHERE id=$1 AND client_id=$2', [req.params.kidId, req.params.id]);
    res.json({ ok: true });
  })
);

// POST /api/clients/:id/bonus — ручная корректировка бонусов
clientsRouter.post(
  '/:id/bonus',
  ah(async (req, res) => {
    const { points, reason = 'Ручная корректировка' } = req.body || {};
    const p = Number(points);
    if (!p) return res.status(400).json({ error: 'Укажите количество баллов' });
    const row = await tx(async ({ q1: cq1 }) => {
      await cq1('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
        req.params.id,
        p,
        reason,
      ]);
      return cq1('UPDATE clients SET bonus = bonus + $2 WHERE id=$1 RETURNING *', [req.params.id, p]);
    });
    await audit(req, 'client.bonus.adjust', { entity: 'client', entityId: req.params.id, meta: { points: p } });
    res.json(row);
  })
);

// GET /api/clients/birthdays/upcoming — дети с днём рождения в ближайшие N дней
clientsRouter.get(
  '/birthdays/upcoming',
  ah(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 14, 90);
    const rows = await q(
      `SELECT k.id, k.name AS kid_name, k.birth_date, c.id AS client_id, c.full_name, c.phone, c.app_installed,
              (date_part('doy', k.birth_date) )::int AS doy
         FROM client_kids k JOIN clients c ON c.id = k.client_id
        WHERE k.birth_date IS NOT NULL`,
      []
    );
    // Считаем ближайший ДР в JS (проще, чем в SQL с учётом перехода через год)
    const today = new Date();
    const withNext = rows
      .map((r) => {
        const b = new Date(r.birth_date);
        let next = new Date(today.getFullYear(), b.getMonth(), b.getDate());
        if (next < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
          next = new Date(today.getFullYear() + 1, b.getMonth(), b.getDate());
        }
        const inDays = Math.round((next - today) / 86400000);
        const turns = next.getFullYear() - b.getFullYear();
        return { ...r, in_days: inDays, turns_age: turns, next_date: next.toISOString().slice(0, 10) };
      })
      .filter((r) => r.in_days <= days)
      .sort((a, b) => a.in_days - b.in_days);
    res.json(withNext);
  })
);
