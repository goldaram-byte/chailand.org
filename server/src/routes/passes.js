// Абонементы в парк.
// Виды абонементов (pass_types) настраивает владелец/админ (право catalog).
// Касса (право pos) продаёт абонемент клиенту по карте и списывает посещения
// при входе. Продажа по умолчанию проводится по кассе (фискальный чек через
// createSale — попадает в смену и выручку кассира); fiscal=false — только запись.
import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale } from '../services/sales.js';

export const passesRouter = Router();
passesRouter.use(requireAuth);

const canEditTypes = requirePerm('catalog');
const canSell = requirePerm('pos');

// ------------------------------ виды абонементов ---------------------------
passesRouter.get(
  '/types',
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM pass_types ORDER BY sort, id'));
  })
);

passesRouter.post(
  '/types',
  canEditTypes,
  ah(async (req, res) => {
    const { name, price = 0, visits = null, valid_days = 30, location_id = null } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Укажите название абонемента' });
    const row = await q1(
      `INSERT INTO pass_types (name, price, visits, valid_days, location_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [String(name).trim(), price, visits || null, valid_days || 30, location_id || null]
    );
    await audit(req, 'pass_type.create', { entity: 'pass_type', entityId: row.id });
    res.json(row);
  })
);

passesRouter.put(
  '/types/:id',
  canEditTypes,
  ah(async (req, res) => {
    const { name, price, visits, valid_days, location_id, is_active } = req.body || {};
    const visitsProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'visits');
    const locProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'location_id');
    const row = await q1(
      `UPDATE pass_types SET
         name = COALESCE($2, name),
         price = COALESCE($3, price),
         visits = CASE WHEN $4::bool THEN $5 ELSE visits END,
         valid_days = COALESCE($6, valid_days),
         location_id = CASE WHEN $7::bool THEN $8 ELSE location_id END,
         is_active = COALESCE($9, is_active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, price, visitsProvided, visits || null, valid_days, locProvided, location_id || null, is_active]
    );
    if (!row) return res.status(404).json({ error: 'Вид абонемента не найден' });
    res.json(row);
  })
);

passesRouter.delete(
  '/types/:id',
  canEditTypes,
  ah(async (req, res) => {
    await tx(async ({ q: cq }) => {
      // Проданные абонементы не трогаем — они хранят копию названия
      await cq('UPDATE passes SET pass_type_id=NULL WHERE pass_type_id=$1', [req.params.id]);
      await cq('DELETE FROM pass_types WHERE id=$1', [req.params.id]);
    });
    res.json({ ok: true });
  })
);

// ------------------------------- продажа ----------------------------------
// POST /api/passes/sell { pass_type_id, client_id, method:'cash'|'card', fiscal:true, location_id }
passesRouter.post(
  '/sell',
  canSell,
  ah(async (req, res) => {
    const { pass_type_id, client_id, method = 'cash', fiscal = true, location_id = null } = req.body || {};
    const type = await q1('SELECT * FROM pass_types WHERE id=$1 AND is_active', [pass_type_id]);
    if (!type) return res.status(404).json({ error: 'Вид абонемента не найден или отключён' });
    const client = await q1('SELECT id, full_name FROM clients WHERE id=$1', [client_id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден — абонемент оформляется на карту клиента' });
    if (!['cash', 'card'].includes(method)) return res.status(400).json({ error: 'Способ оплаты: наличные или карта' });

    let saleId = null;
    const price = Number(type.price);
    if (fiscal && price > 0) {
      // По кассе: фискальный чек + выручка смены. Клиент прикреплён — кэшбэк начислится.
      const sale = await createSale(req.user, {
        items: [{ name: 'Абонемент «' + type.name + '»', qty: 1, price: price }],
        cash_amount: method === 'cash' ? price : 0,
        card_amount: method === 'card' ? price : 0,
        client_id: client.id,
        location_id: location_id || type.location_id || null,
        comment: 'Продажа абонемента',
      });
      saleId = sale.id;
    }

    const pass = await q1(
      `INSERT INTO passes (pass_type_id, client_id, name, visits_total, visits_left,
                           valid_to, sale_id, location_id, sold_by)
       VALUES ($1,$2,$3,$4,$4, current_date + ($5 || ' days')::interval, $6, $7, $8) RETURNING *`,
      [type.id, client.id, type.name, type.visits || null, String(type.valid_days || 30), saleId,
       location_id || type.location_id || null, req.user.id]
    );
    await audit(req, 'pass.sell', { entity: 'pass', entityId: pass.id, meta: { client_id: client.id, type: type.name, fiscal: !!fiscal, sale_id: saleId } });
    res.json({ ...pass, sale_id: saleId, client_name: client.full_name });
  })
);

// ------------------------- абонементы клиента ------------------------------
passesRouter.get(
  '/by-client/:clientId',
  canSell,
  ah(async (req, res) => {
    // Лениво помечаем истёкшие
    await q(`UPDATE passes SET status='expired' WHERE client_id=$1 AND status='active' AND valid_to < current_date`, [req.params.clientId]);
    const rows = await q(
      `SELECT p.*, (SELECT count(*)::int FROM pass_visits v WHERE v.pass_id = p.id) AS visits_used
         FROM passes p WHERE p.client_id=$1 ORDER BY p.created_at DESC LIMIT 20`,
      [req.params.clientId]
    );
    res.json(rows);
  })
);

// --------------------------- списание посещения ----------------------------
passesRouter.post(
  '/:id/checkin',
  canSell,
  ah(async (req, res) => {
    const { location_id = null } = req.body || {};
    const result = await tx(async ({ q1: cq1 }) => {
      const p = await cq1('SELECT * FROM passes WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!p) throw Object.assign(new Error('Абонемент не найден'), { status: 404 });
      if (p.status === 'cancelled') throw Object.assign(new Error('Абонемент аннулирован'), { status: 409 });
      const today = new Date().toISOString().slice(0, 10);
      if (String(p.valid_to).slice(0, 10) < today) {
        await cq1(`UPDATE passes SET status='expired' WHERE id=$1 RETURNING id`, [p.id]);
        throw Object.assign(new Error('Срок действия абонемента истёк ' + String(p.valid_to).slice(0, 10)), { status: 409 });
      }
      if (p.status === 'used_up' || (p.visits_left != null && p.visits_left <= 0)) {
        throw Object.assign(new Error('Посещения по абонементу закончились'), { status: 409 });
      }
      let left = p.visits_left;
      if (left != null) {
        left -= 1;
        await cq1(
          `UPDATE passes SET visits_left=$2, status = CASE WHEN $2 <= 0 THEN 'used_up' ELSE status END WHERE id=$1 RETURNING id`,
          [p.id, left]
        );
      }
      await cq1(
        `INSERT INTO pass_visits (pass_id, by_user, location_id) VALUES ($1,$2,$3) RETURNING id`,
        [p.id, req.user.id, location_id || null]
      );
      return { id: p.id, name: p.name, visits_left: left, unlimited: p.visits_left == null, valid_to: p.valid_to };
    });
    await audit(req, 'pass.checkin', { entity: 'pass', entityId: req.params.id });
    res.json(result);
  })
);

// История посещений по абонементу
passesRouter.get(
  '/:id/visits',
  canSell,
  ah(async (req, res) => {
    const rows = await q(
      `SELECT v.*, u.full_name AS user_name FROM pass_visits v
         LEFT JOIN users u ON u.id = v.by_user
        WHERE v.pass_id=$1 ORDER BY v.at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  })
);
