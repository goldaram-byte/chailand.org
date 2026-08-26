// Праздники → журнал мероприятий.
// Статусы: new (предбронь) → prepaid (бронь) → paid (оплачено) → done (реализовано),
// плюс cancelled. Бронирование привязано к ТЦ (журнал общий для всех сотрудников
// точки) и к продавцу — кассиру, который продал праздник. Продавца может менять
// только владелец. Оплату можно провести двумя способами:
//   • «по кассе» (fiscal=true)  — создаётся обычная продажа: чек уходит в ОФД,
//     сумма попадает в смену/выручку кассира;
//   • «без фискализации» (fiscal=false) — просто отметка об оплате в журнале.
import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale } from '../services/sales.js';

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth, requirePerm('bookings'));

const STATUSES = ['new', 'prepaid', 'paid', 'done', 'cancelled', 'confirmed'];

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
      comment,
      total = 0,
      location_id = null,
    } = req.body || {};
    if (!client_name || !date) return res.status(400).json({ error: 'Укажите имя и дату' });
    const row = await q1(
      `INSERT INTO bookings (client_name, phone, date, time, time_to, room_id, services, kids_count,
                             comment, total, location_id, seller_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new') RETURNING *`,
      [client_name, phone || null, date, time || null, time_to || null, room_id || null,
       JSON.stringify(services), kids_count, comment || null, total, location_id || null, req.user.id]
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
         seller_id = COALESCE($12, seller_id)
       WHERE id=$1 RETURNING *`,
      [req.params.id, status, total, comment, time, time_to, room_id, date, kids_count,
       svcProvided, JSON.stringify(services || []), seller_id]
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

    let saleId = null;
    if (fiscal) {
      // Провести по кассе: обычная продажа → фискальный чек + выручка кассира.
      const sale = await createSale(req.user, {
        items: [{ name: 'Праздник №' + b.id + ' · ' + b.client_name, qty: 1, price: a }],
        cash_amount: method === 'cash' ? a : 0,
        card_amount: method === 'card' ? a : 0,
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

bookingsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await q('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    await audit(req, 'booking.delete', { entity: 'booking', entityId: req.params.id });
    res.json({ ok: true });
  })
);
