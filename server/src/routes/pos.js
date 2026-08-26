import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale, createReturn, loadSale } from '../services/sales.js';

export const posRouter = Router();
posRouter.use(requireAuth);

// ---------------- Смены ----------------
posRouter.get(
  '/shift/current',
  ah(async (req, res) => {
    const shift = await q1(
      `SELECT s.*, u.full_name AS cashier_name FROM cash_shifts s
         JOIN users u ON u.id = s.cashier_id
        WHERE s.closed_at IS NULL AND s.cashier_id=$1
        ORDER BY s.opened_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(shift || null);
  })
);

posRouter.post(
  '/shift/open',
  requirePerm('shifts'),
  ah(async (req, res) => {
    const existing = await q1(`SELECT id FROM cash_shifts WHERE closed_at IS NULL AND cashier_id=$1`, [req.user.id]);
    if (existing) return res.status(409).json({ error: 'Смена уже открыта' });
    const { cash_start = 0, note, location_id = null } = req.body || {};
    const row = await q1('INSERT INTO cash_shifts (cashier_id, cash_start, note, location_id) VALUES ($1,$2,$3,$4) RETURNING *', [
      req.user.id,
      cash_start,
      note || null,
      location_id || null,
    ]);
    await audit(req, 'shift.open', { entity: 'shift', entityId: row.id });
    res.json(row);
  })
);

posRouter.post(
  '/shift/close',
  requirePerm('shifts'),
  ah(async (req, res) => {
    const { cash_end, note } = req.body || {};
    const shift = await q1(`SELECT * FROM cash_shifts WHERE closed_at IS NULL AND cashier_id=$1`, [req.user.id]);
    if (!shift) return res.status(404).json({ error: 'Открытой смены нет' });
    const totals = await q1(
      `SELECT COALESCE(SUM(cash_amount),0) AS cash, COALESCE(SUM(card_amount),0) AS card,
              COALESCE(SUM(total),0) AS total, count(*) FILTER (WHERE NOT is_return) AS sales,
              count(*) FILTER (WHERE is_return) AS returns
         FROM sales WHERE shift_id=$1`,
      [shift.id]
    );
    const row = await q1(
      `UPDATE cash_shifts SET closed_at=now(), cash_end=$2, note=COALESCE($3,note) WHERE id=$1 RETURNING *`,
      [shift.id, cash_end ?? null, note ?? null]
    );
    await audit(req, 'shift.close', { entity: 'shift', entityId: shift.id, meta: totals });
    res.json({ ...row, totals });
  })
);

// ---------------- Продажи ----------------
posRouter.get(
  '/sales',
  ah(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // Фильтр по точке (ТЦ): выбран конкретный — показываем продажи только этой точки
    const loc = req.query.location_id && req.query.location_id !== 'all' ? Number(req.query.location_id) : null;
    const rows = await q(
      `SELECT s.*, u.full_name AS cashier_name, c.full_name AS client_name,
              COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty,'price',i.price,'sum',i.sum))
                       FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.cashier_id
         LEFT JOIN clients c ON c.id = s.client_id
         LEFT JOIN sale_items i ON i.sale_id = s.id
        WHERE ($2::bigint IS NULL OR s.location_id = $2)
        GROUP BY s.id, u.full_name, c.full_name
        ORDER BY s.created_at DESC LIMIT $1`,
      [limit, loc]
    );
    res.json(rows);
  })
);

posRouter.get(
  '/sales/:id',
  ah(async (req, res) => {
    const sale = await loadSale(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Продажа не найдена' });
    res.json(sale);
  })
);

posRouter.post(
  '/sales',
  requirePerm('pos'),
  ah(async (req, res) => {
    const sale = await createSale(req.user, req.body);
    if (!sale.idempotent) await audit(req, 'sale.create', { entity: 'sale', entityId: sale.id, meta: { total: sale.total, method: sale.method } });
    res.json(sale);
  })
);

posRouter.post(
  '/returns',
  requirePerm('returns'),
  ah(async (req, res) => {
    const ret = await createReturn(req.user, req.body);
    if (!ret.idempotent) await audit(req, 'return.create', { entity: 'sale', entityId: ret.id, meta: { parent: ret.parent_sale_id } });
    res.json(ret);
  })
);
