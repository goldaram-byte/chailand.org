import { Router } from 'express';
import { q, q1, tx } from '../db.js';
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
              f.status AS fiscal_status, f.driver AS fiscal_driver, f.fd_number,
              COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty,'price',i.price,'sum',i.sum))
                       FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.cashier_id
         LEFT JOIN clients c ON c.id = s.client_id
         LEFT JOIN sale_items i ON i.sale_id = s.id
         LEFT JOIN LATERAL (
           SELECT status, driver, fd_number FROM fiscal_docs d
            WHERE d.sale_id = s.id ORDER BY d.id DESC LIMIT 1
         ) f ON true
        WHERE ($2::bigint IS NULL OR s.location_id = $2)
        GROUP BY s.id, u.full_name, c.full_name, f.status, f.driver, f.fd_number
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

// DELETE /api/pos/sales/:id — удалить ошибочную оплату из кассы.
// Доступно только владельцу и администратору. Фискализированный чек удалить
// нельзя: пробитый чек аннулируется возвратом, а не удалением.
// При удалении откатываются бонусы клиента и складские остатки.
posRouter.delete(
  '/sales/:id',
  ah(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Удалять оплаты может только владелец или администратор' });
    }
    const sale = await q1('SELECT * FROM sales WHERE id=$1', [req.params.id]);
    if (!sale) return res.status(404).json({ error: 'Оплата не найдена' });

    // Пробитый (зарегистрированный в ОФД) чек удалять нельзя
    // Эмуляция ОФД «регистрирует» чеки понарошку — она удалению не мешает.
    // Блокируем только чеки, реально пробитые на ККТ или зарегистрированные в ОФД.
    const registered = await q1(
      `SELECT id, fd_number FROM fiscal_docs
        WHERE sale_id=$1 AND status='registered' AND driver <> 'emulation' LIMIT 1`,
      [sale.id]
    );
    if (registered) {
      return res.status(409).json({
        error: 'Чек фискализирован (ФД №' + (registered.fd_number || '—') + ') — его нельзя удалить. Оформите возврат.',
      });
    }
    // Если по продаже уже оформлен возврат — сначала он
    const hasReturn = await q1('SELECT id FROM sales WHERE parent_sale_id=$1 LIMIT 1', [sale.id]);
    if (hasReturn) {
      return res.status(409).json({ error: 'По этой продаже оформлен возврат — удалить её нельзя' });
    }
    // По продаже мог быть выдан абонемент — им уже могли пользоваться, молча стирать нельзя
    const soldPass = await q1('SELECT id FROM passes WHERE sale_id=$1 LIMIT 1', [sale.id]);
    if (soldPass) {
      return res.status(409).json({
        error: 'По этой продаже выдан абонемент №' + soldPass.id + ' — удалить её нельзя. Оформите возврат.',
      });
    }

    await tx(async ({ q1: cq1, q: cq }) => {
      // Вернуть клиенту потраченные бонусы и снять начисленные
      if (sale.client_id) {
        const delta = Number(sale.bonus_used) - Number(sale.bonus_earned);
        if (delta !== 0) {
          await cq('UPDATE clients SET bonus = bonus + $2 WHERE id=$1', [sale.client_id, delta]);
        }
        await cq('DELETE FROM loyalty_transactions WHERE sale_id=$1', [sale.id]);
      }
      // Вернуть на склад товары с учётом остатков
      const items = await cq('SELECT product_id, qty FROM sale_items WHERE sale_id=$1', [sale.id]);
      for (const it of items) {
        if (!it.product_id) continue;
        const qty = Number(it.qty);
        // продажа списывала qty — возвращаем столько же обратно
        const tracked = await cq1(
          `UPDATE products SET stock = stock + $2 WHERE id=$1 AND track_stock RETURNING id`,
          [it.product_id, qty]
        );
        if (tracked) {
          await cq(
            `INSERT INTO stock_moves (product_id, delta, reason, note, created_by) VALUES ($1,$2,'adjust',$3,$4)`,
            [it.product_id, qty, 'Удаление оплаты №' + sale.id, req.user.id]
          );
        }
      }
      // Позиции чека и фискальные документы уходят каскадом
      await cq('DELETE FROM sales WHERE id=$1', [sale.id]);
    });

    await audit(req, 'sale.delete', {
      entity: 'sale', entityId: sale.id,
      meta: { total: sale.total, method: sale.method, client_id: sale.client_id },
    });
    res.json({ ok: true });
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
