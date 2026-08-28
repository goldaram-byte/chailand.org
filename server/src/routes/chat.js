// Чат сотрудников: общий канал внутри админки. Все сотрудники видят все
// сообщения; писать может любой вошедший. Удалять сообщение может автор
// или владелец. Клиентам (приложению) чат недоступен — только staff-токены.
import { Router } from 'express';
import { q, q1 } from './../db.js';
import { requireAuth } from '../auth.js';
import { ah, audit } from '../util.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

// GET /api/chat?after_id=N — последние сообщения (или только новее after_id
// для поллинга). Отдаём по возрастанию id, чтобы касса просто дорисовывала.
chatRouter.get(
  '/',
  ah(async (req, res) => {
    const after = Number(req.query.after_id) || 0;
    const rows = await q(
      `SELECT m.id, m.user_id, m.text, m.created_at, m.location_id,
              u.full_name AS user_name, u.role_code,
              l.name AS location_name
         FROM staff_messages m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN locations l ON l.id = m.location_id
        WHERE m.id > $1
        ORDER BY m.id DESC LIMIT 100`,
      [after]
    );
    res.json(rows.reverse());
  })
);

chatRouter.post(
  '/',
  ah(async (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинное сообщение (до 2000 символов)' });
    const loc = Number((req.body || {}).location_id) || null;
    const row = await q1(
      `INSERT INTO staff_messages (user_id, text, location_id) VALUES ($1,$2,$3) RETURNING id, created_at`,
      [req.user.id, text, loc]
    );
    res.json({ ...row, user_id: req.user.id, text });
  })
);

// Удалить сообщение: автор — своё, владелец — любое (модерация).
chatRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const m = await q1('SELECT * FROM staff_messages WHERE id=$1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (m.user_id !== req.user.id && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Удалять можно только свои сообщения' });
    }
    await q1('DELETE FROM staff_messages WHERE id=$1 RETURNING id', [m.id]);
    await audit(req, 'chat.delete', { entity: 'chat', entityId: m.id, meta: { author: m.user_id } });
    res.json({ ok: true });
  })
);
