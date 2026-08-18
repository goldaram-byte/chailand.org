import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const bookingsRouter = Router();
bookingsRouter.use(requireAuth, requirePerm('bookings'));

bookingsRouter.get(
  '/',
  ah(async (req, res) => {
    const rows = await q(
      `SELECT b.*, r.name AS room_name FROM bookings b
         LEFT JOIN rooms r ON r.id = b.room_id
        ORDER BY b.date DESC, b.time`
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
      room_id,
      service_ids = [],
      kids_count = 0,
      comment,
      prepay = 0,
      total = 0,
    } = req.body || {};
    if (!client_name || !date) return res.status(400).json({ error: 'Укажите имя и дату' });
    const row = await q1(
      `INSERT INTO bookings (client_name, phone, date, time, room_id, service_ids, kids_count, comment, prepay, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [client_name, phone || null, date, time || null, room_id || null, JSON.stringify(service_ids), kids_count, comment || null, prepay, total]
    );
    await audit(req, 'booking.create', { entity: 'booking', entityId: row.id });
    res.json(row);
  })
);

bookingsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const { status, prepay, total, comment, time, room_id, date } = req.body || {};
    const row = await q1(
      `UPDATE bookings SET
         status=COALESCE($2,status), prepay=COALESCE($3,prepay), total=COALESCE($4,total),
         comment=COALESCE($5,comment), time=COALESCE($6,time), room_id=COALESCE($7,room_id), date=COALESCE($8,date)
       WHERE id=$1 RETURNING *`,
      [req.params.id, status, prepay, total, comment, time, room_id, date]
    );
    res.json(row);
  })
);

bookingsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await q('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);
