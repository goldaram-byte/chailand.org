// Праздники → журнал мероприятий.
// Статусы: new (предбронь) → prepaid (бронь) → paid (оплачено) → done (реализовано),
// плюс cancelled. Бронирование привязано к ТЦ (журнал общий для всех сотрудников
// точки) и к продавцу — кассиру, который продал праздник. Продавца может менять
// только владелец. Оплату можно провести двумя способами:
//   • «по кассе» (fiscal=true)  — создаётся обычная продажа: чек уходит в ОФД,
//     сумма попадает в смену/выручку кассира;
//   • «без фискализации» (fiscal=false) — просто отметка об оплате в журнале.
import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale, bookingCashbackPercent } from '../services/sales.js';

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth, requirePerm('bookings'));

const STATUSES = ['new', 'prepaid', 'paid', 'done', 'cancelled', 'confirmed'];

const trimOrNull = (v) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};
// Возраст именинника: пусто — не указан, иначе 1..18. false — значение неверное.
function kidAge(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 18) return false;
  return n;
}

bookingsRouter.get(
  '/',
  ah(async (req, res) => {
    // Журнал своего ТЦ: ?location_id=N (бронирования без точки видны везде).
    const loc = req.query.location_id ? Number(req.query.location_id) : null;
    const rows = await q(
      `SELECT b.*, r.name AS room_name, u.full_name AS seller_name
         FROM bookings b
         LEFT JOIN rooms r ON r.id = b.room_id
         LEFT JOIN users u ON u.id = b.seller_id
        WHERE ($1::bigint IS NULL OR b.location_id = $1 OR b.location_id IS NULL)
        ORDER BY b.date DESC, b.time`,
      [loc]
    );
    res.json(rows);
  })
);

bookingsRouter.post(
  '/',
  ah(async (req, res) => {
    const {
      client_name,
      phone,
      date,
      time,
      time_to,
      room_id,
      services = [],
      kids_count = 0,
      kid_name = null,
      kid_age = null,
      comment,
      total = 0,
      location_id = null,
    } = req.body || {};
    if (!client_name || !date) return res.status(400).json({ error: 'Укажите имя и дату' });
    const age = kidAge(kid_age);
    if (age === false) return res.status(400).json({ error: 'Возраст именинника — число от 1 до 18' });
    const row = await q1(
      `INSERT INTO bookings (client_name, phone, date, time, time_to, room_id, services, kids_count,
                             kid_name, kid_age, comment, total, location_id, seller_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new') RETURNING *`,
      [client_name, phone || null, date, time || null, time_to || null, room_id || null,
       JSON.stringify(services), kids_count, trimOrNull(kid_name), age,
       comment || null, total, location_id || null, req.user.id]
    );
    await audit(req, 'booking.create', { entity: 'booking', entityId: row.id });
    res.json(row);
  })
);

bookingsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const { status, total, comment, time, time_to, room_id, date, kids_count, services, seller_id } = req.body || {};
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Неизвестный статус' });
    // Именинника можно и стереть, поэтому COALESCE тут не подходит: смотрим,
    // прислали поле или нет.
    const kidNameSet = Object.prototype.hasOwnProperty.call(req.body || {}, 'kid_name');
    const kidAgeSet = Object.prototype.hasOwnProperty.call(req.body || {}, 'kid_age');
    const age = kidAgeSet ? kidAge(req.body.kid_age) : null;
    if (age === false) return res.status(400).json({ error: 'Возраст именинника — число от 1 до 18' });
    // Менять, кому засчитана продажа праздника, может только владелец.
    if (seller_id !== undefined && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Менять продавца может только владелец' });
    }
    const svcProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'services');
    const row = await q1(
      `UPDATE bookings SET
         status=COALESCE($2,status), total=COALESCE($3,total), comment=COALESCE($4,comment),
         time=COALESCE($5,time), time_to=COALESCE($6,time_to), room_id=COALESCE($7,room_id),
         date=COALESCE($8,date), kids_count=COALESCE($9,kids_count),
         services = CASE WHEN $10::bool THEN $11::jsonb ELSE services END,
         seller_id = COALESCE($12, seller_id),
         kid_name = CASE WHEN $13::bool THEN $14 ELSE kid_name END,
         kid_age  = CASE WHEN $15::bool THEN $16 ELSE kid_age END
       WHERE id=$1 RETURNING *`,
      [req.params.id, status, total, comment, time, time_to, room_id, date, kids_count,
       svcProvided, JSON.stringify(services || []), seller_id,
       kidNameSet, trimOrNull(req.body.kid_name), kidAgeSet, age]
    );
    if (!row) return res.status(404).json({ error: 'Бронирование не найдено' });
    await audit(req, 'booking.update', { entity: 'booking', entityId: req.params.id });
    res.json(row);
  })
);

// POST /api/bookings/:id/pay — принять оплату по бронированию.
//   { amount, method: 'cash'|'card', fiscal: true|false }
//   fiscal=true  → проводится по кассе: создаётся продажа (чек в ОФД, выручка смены);
//   fiscal=false → без фискализации: только отметка об оплате в журнале.
bookingsRouter.post(
  '/:id/pay',
  ah(async (req, res) => {
    const { amount, method = 'cash', fiscal = true } = req.body || {};
    const a = Math.round(Number(amount) * 100) / 100;
    if (!a || a <= 0) return res.status(400).json({ error: 'Укажите сумму оплаты' });
    if (!['cash', 'card'].includes(method)) return res.status(400).json({ error: 'Способ оплаты: наличные или карта' });
    const b = await q1('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Бронирование не найдено' });
    if (b.status === 'cancelled') return res.status(409).json({ error: 'Бронирование отменено' });

    // Клиент брони: если её не привязали, ищем по телефону — иначе кэшбэк
    // за праздник некому начислить.
    let clientId = b.client_id || null;
    if (!clientId && b.phone) {
      const digits = String(b.phone).replace(/\D/g, '');
      if (digits.length >= 10) {
        const tail = digits.slice(-10);
        const c = await q1(
          `SELECT id FROM clients WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1`,
          [tail]
        );
        if (c) {
          clientId = c.id;
          await q('UPDATE bookings SET client_id=$2 WHERE id=$1', [b.id, clientId]);
        }
      }
    }

    let saleId = null;
    if (fiscal) {
      // Провести по кассе: обычная продажа → фискальный чек + выручка кассира.
      // Кэшбэк за праздник считается по своей настройке.
      const sale = await createSale(req.user, {
        items: [{ name: 'Праздник №' + b.id + ' · ' + b.client_name, qty: 1, price: a }],
        cash_amount: method === 'cash' ? a : 0,
        card_amount: method === 'card' ? a : 0,
        client_id: clientId,
        cashback_percent: await bookingCashbackPercent(),
        location_id: b.location_id || null,
        comment: 'Оплата бронирования №' + b.id,
      });
      saleId = sale.id;
    }

    const payments = Array.isArray(b.payments) ? b.payments : [];
    payments.push({
      amount: a, method, fiscal: !!fiscal, sale_id: saleId,
      at: new Date().toISOString(), by: req.user.id, by_name: req.user.name || null,
    });
    const prepay = Number(b.prepay) + a;
    const total = Number(b.total);
    // done не понижаем; полная оплата → paid, частичная → prepaid (бронь)
    const status = b.status === 'done' ? 'done' : (total > 0 && prepay >= total ? 'paid' : 'prepaid');
    const row = await q1(
      `UPDATE bookings SET prepay=$2, payments=$3::jsonb, status=$4 WHERE id=$1 RETURNING *`,
      [b.id, prepay, JSON.stringify(payments), status]
    );
    await audit(req, 'booking.pay', { entity: 'booking', entityId: b.id, meta: { amount: a, method, fiscal: !!fiscal, sale_id: saleId } });
    res.json({ ...row, sale_id: saleId });
  })
);

// PATCH /api/bookings/:id/payments/:idx — изменить сумму уже внесённой оплаты.
// Только владелец/администратор: правка денег — не кассирская операция.
// Оплата «по кассе» тянет за собой продажу: пересчитываются её сумма и
// кэшбэк клиента; фискализированный чек (реальный, не эмуляция) менять
// нельзя — его аннулируют возвратом.
bookingsRouter.patch(
  '/:id/payments/:idx',
  ah(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Менять суммы оплат может только владелец или администратор' });
    }
    const a = Math.round(Number((req.body || {}).amount) * 100) / 100;
    if (!a || a <= 0) return res.status(400).json({ error: 'Укажите сумму больше нуля' });

    const b = await q1('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    if (!b) return res.status(404).json({ error: 'Бронирование не найдено' });
    const payments = Array.isArray(b.payments) ? b.payments : [];
    const idx = Number(req.params.idx);
    const p = payments[idx];
    if (!p) return res.status(404).json({ error: 'Оплата не найдена' });
    const old = Math.round(Number(p.amount) * 100) / 100;
    if (a === old) return res.json(b);

    await tx(async ({ q: cq, q1: cq1 }) => {
      if (p.sale_id) {
        const sale = await cq1('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [p.sale_id]);
        if (sale) {
          if (sale.is_return || sale.status === 'returned') {
            throw Object.assign(new Error('По этой оплате уже оформлен возврат — сумму не изменить'), { status: 409 });
          }
          const fd = await cq1(
            `SELECT id FROM fiscal_docs WHERE sale_id=$1 AND status='registered' AND driver IS NOT NULL AND driver <> 'emulation' LIMIT 1`,
            [sale.id]
          );
          if (fd) {
            throw Object.assign(new Error('Чек уже фискализирован — сумму не изменить. Оформите возврат и примите оплату заново.'), { status: 409 });
          }
          // Пересчитать продажу и кэшбэк клиента на разницу
          const wasEarned = Number(sale.bonus_earned) || 0;
          const pct = sale.total > 0 ? wasEarned / Number(sale.total) : 0;
          const newEarned = Math.floor(a * pct);
          await cq(
            `UPDATE sales SET total=$2,
                    cash_amount = CASE WHEN cash_amount > 0 THEN $2 ELSE cash_amount END,
                    card_amount = CASE WHEN card_amount > 0 THEN $2 ELSE card_amount END,
                    bonus_earned=$3
              WHERE id=$1`,
            [sale.id, a, newEarned]
          );
          await cq(`UPDATE sale_items SET price=$2, sum=$2 WHERE sale_id=$1`, [sale.id, a]);
          if (sale.client_id && newEarned !== wasEarned) {
            const diff = newEarned - wasEarned;
            await cq('UPDATE loyalty_transactions SET points=$2 WHERE sale_id=$1 AND points=$3', [sale.id, newEarned, wasEarned]);
            await cq('UPDATE clients SET bonus = bonus + $2 WHERE id=$1', [sale.client_id, diff]);
          }
        }
      }
      payments[idx] = { ...p, amount: a, edited_at: new Date().toISOString(), edited_by: req.user.name || null };
      const prepay = payments.reduce((sum, x) => sum + (Number(x.amount) || 0), 0);
      const total = Number(b.total);
      const status = ['done', 'cancelled'].includes(b.status)
        ? b.status
        : (total > 0 && prepay >= total ? 'paid' : (prepay > 0 ? 'prepaid' : 'new'));
      await cq(`UPDATE bookings SET prepay=$2, payments=$3::jsonb, status=$4 WHERE id=$1`,
        [b.id, prepay, JSON.stringify(payments), status]);
    });
    await audit(req, 'booking.pay.edit', { entity: 'booking', entityId: b.id, meta: { idx, from: old, to: a, sale_id: p.sale_id || null } });
    res.json(await q1('SELECT * FROM bookings WHERE id=$1', [b.id]));
  })
);

bookingsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await q('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    await audit(req, 'booking.delete', { entity: 'booking', entityId: req.params.id });
    res.json({ ok: true });
  })
);
