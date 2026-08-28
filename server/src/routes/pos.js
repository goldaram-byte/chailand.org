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
      `SELECT s.*, u.full_name AS cashier_name, l.name AS location_name FROM cash_shifts s
         JOIN users u ON u.id = s.cashier_id
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.closed_at IS NULL AND s.cashier_id=$1
        ORDER BY s.opened_at DESC LIMIT 1`,
      [req.user.id]
    );
    res.json(shift || null);
  })
);

// Кассир видит только свои смены; владелец и администратор — все.
async function canSeeShift(user, shiftId) {
  if (['owner', 'admin'].includes(user.role)) return true;
  const sh = await q1('SELECT cashier_id FROM cash_shifts WHERE id=$1', [shiftId]);
  return !!sh && String(sh.cashier_id) === String(user.id);
}

// GET /api/pos/shifts — история смен, каждая отдельной строкой со своими
// итогами. Раньше отчёт складывал все смены кассира в одну сумму, и понять,
// сколько сдал человек за конкретный день, было нельзя.
//   ?location_id=N  — только смены этой точки
//   ?cashier_id=N   — только смены сотрудника (владелец/админ)
//   ?from&to        — период по дате открытия (YYYY-MM-DD)
//   ?limit=N        — сколько смен вернуть (по умолчанию 50, максимум 200)
posRouter.get(
  '/shifts',
  ah(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const params = [limit];
    const where = [];
    // Кассиру — только его смены, чужую выручку он видеть не должен
    if (!['owner', 'admin'].includes(req.user.role)) {
      params.push(req.user.id);
      where.push(`sh.cashier_id = $${params.length}`);
    } else if (req.query.cashier_id && req.query.cashier_id !== 'all') {
      params.push(Number(req.query.cashier_id));
      where.push(`sh.cashier_id = $${params.length}`);
    }
    if (req.query.location_id && req.query.location_id !== 'all') {
      params.push(Number(req.query.location_id));
      where.push(`sh.location_id = $${params.length}`);
    }
    if (req.query.from) { params.push(req.query.from); where.push(`sh.opened_at >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); where.push(`sh.opened_at < ($${params.length}::date + 1)`); }
    const rows = await q(
      `SELECT sh.id, sh.cashier_id, u.full_name AS cashier_name,
              sh.location_id, l.name AS location_name,
              sh.opened_at, sh.closed_at, sh.cash_start, sh.cash_end, sh.note,
              COALESCE(SUM(s.total)   FILTER (WHERE NOT s.is_return), 0) AS revenue,
              COALESCE(-SUM(s.total)  FILTER (WHERE s.is_return), 0)     AS refunds,
              COALESCE(SUM(s.cash_amount), 0)                            AS cash,
              COALESCE(SUM(s.card_amount), 0)                            AS card,
              COALESCE(SUM(s.bonus_used)   FILTER (WHERE NOT s.is_return), 0) AS bonus_used,
              COALESCE(SUM(s.bonus_earned) FILTER (WHERE NOT s.is_return), 0) AS bonus_earned,
              count(s.id) FILTER (WHERE NOT s.is_return)::int AS checks,
              count(s.id) FILTER (WHERE s.is_return)::int     AS returns
         FROM cash_shifts sh
         JOIN users u ON u.id = sh.cashier_id
         LEFT JOIN locations l ON l.id = sh.location_id
         LEFT JOIN sales s ON s.shift_id = sh.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        GROUP BY sh.id, u.full_name, l.name
        ORDER BY sh.opened_at DESC
        LIMIT $1`,
      params
    );
    res.json(
      rows.map((r) => {
        const cash = Number(r.cash);
        const expected = Number(r.cash_start) + cash; // наличные, которые должны быть в кассе
        return {
          id: r.id,
          cashier_id: r.cashier_id,
          cashier_name: r.cashier_name,
          location_id: r.location_id,
          location_name: r.location_name,
          opened_at: r.opened_at,
          closed_at: r.closed_at,
          open: !r.closed_at,
          note: r.note,
          cash_start: Number(r.cash_start),
          cash_end: r.cash_end == null ? null : Number(r.cash_end),
          revenue: Number(r.revenue),
          refunds: Number(r.refunds),
          cash,
          card: Number(r.card),
          bonus_used: Number(r.bonus_used),
          bonus_earned: Number(r.bonus_earned),
          checks: r.checks,
          returns: r.returns,
          expected_cash: expected,
          // Расхождение считаем только у закрытых смен, где кассир внёс факт
          diff: r.cash_end == null ? null : Math.round((Number(r.cash_end) - expected) * 100) / 100,
        };
      })
    );
  })
);

posRouter.post(
  '/shift/open',
  requirePerm('shifts'),
  ah(async (req, res) => {
    const { cash_start = 0, note, location_id = null } = req.body || {};
    // У сотрудника может быть только одна открытая смена. Если она открыта в
    // другом ТЦ — здесь работать нельзя, пока ту не закроют: иначе выручка
    // одной точки попадёт в смену другой.
    const existing = await q1(
      `SELECT s.*, l.name AS location_name FROM cash_shifts s
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.closed_at IS NULL AND s.cashier_id=$1`,
      [req.user.id]
    );
    if (existing) {
      const same = String(existing.location_id || '') === String(location_id || '');
      if (same) return res.json({ ...existing, already_open: true }); // продолжаем начатую смену
      return res.status(409).json({
        error: 'У вас уже открыта смена в «' + (existing.location_name || 'другом ТЦ') +
               '». Закройте её там, чтобы открыть смену здесь.',
      });
    }
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
    // Фильтр по смене. Касса запрашивает shift_id=current: каждая смена —
    // отдельная история, после закрытия список пуст, прошлые дни в кассу не
    // подмешиваются. Конкретный id смены доступен только своей смене — чужую
    // может открыть админ или владелец.
    let shiftId = null;
    if (req.query.shift_id === 'current') {
      const cur = await q1('SELECT id FROM cash_shifts WHERE closed_at IS NULL AND cashier_id=$1', [req.user.id]);
      if (cur) {
        shiftId = cur.id;
      } else if (!['owner', 'admin'].includes(req.user.role)) {
        return res.json([]); // смена закрыта — кассиру показывать нечего
      }
      // Владелец и администратор без открытой смены — надзорный режим: видят
      // последние продажи точки, иначе ошибочную оплату им не найти и не удалить.
    } else if (req.query.shift_id) {
      shiftId = Number(req.query.shift_id);
      if (!(await canSeeShift(req.user, shiftId))) {
        return res.status(403).json({ error: 'Смотреть чужую смену может владелец или администратор' });
      }
    }
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
          AND ($3::bigint IS NULL OR s.shift_id = $3)
        GROUP BY s.id, u.full_name, c.full_name, f.status, f.driver, f.fd_number
        ORDER BY s.created_at DESC LIMIT $1`,
      [limit, loc, shiftId]
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
