// Чат сотрудников: общий канал + личные переписки один на один.
// Личное сообщение видят только отправитель и получатель (и никто больше,
// включая владельца — это переписка, а не отчётность); удалить сообщение
// может автор, в общем чате владелец может удалить любое (модерация).
// Прочитанность считается на сервере (staff_chat_reads), чтобы бейджи
// сходились на всех устройствах сотрудника.
import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth } from '../auth.js';
import { ah, audit } from '../util.js';

export const chatRouter = Router();
chatRouter.use(requireAuth);

const peerKey = (peerId) => (peerId ? String(peerId) : 'all');

async function markRead(userId, peerId, lastId) {
  if (!lastId) return;
  await q(
    `INSERT INTO staff_chat_reads (user_id, peer_key, last_read_id) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, peer_key) DO UPDATE SET last_read_id = GREATEST(staff_chat_reads.last_read_id, $3)`,
    [userId, peerKey(peerId), lastId]
  );
}

// GET /api/chat/threads — список чатов: общий + все сотрудники, с числом
// непрочитанных и последним сообщением. Сортировка: общий, затем по свежести.
chatRouter.get(
  '/threads',
  ah(async (req, res) => {
    const me = req.user.id;
    const users = await q(
      `SELECT id, full_name, role_code FROM users WHERE is_active AND id <> $1 ORDER BY full_name`,
      [me]
    );
    // непрочитанное в личных: сообщения мне, новее моей отметки по этому собеседнику
    const unread = await q(
      `SELECT m.user_id AS peer, count(*)::int AS c, max(m.id) AS last_id
         FROM staff_messages m
        WHERE m.recipient_id = $1
          AND m.id > COALESCE((SELECT last_read_id FROM staff_chat_reads r
                                WHERE r.user_id = $1 AND r.peer_key = m.user_id::text), 0)
        GROUP BY m.user_id`,
      [me]
    );
    const unreadBy = {}; unread.forEach((u) => { unreadBy[u.peer] = u.c; });
    // последнее сообщение в каждой личной переписке
    const last = await q(
      `SELECT DISTINCT ON (peer) peer, text, created_at, id FROM (
         SELECT CASE WHEN user_id=$1 THEN recipient_id ELSE user_id END AS peer,
                text, created_at, id
           FROM staff_messages
          WHERE recipient_id IS NOT NULL AND (user_id=$1 OR recipient_id=$1)
       ) t ORDER BY peer, id DESC`,
      [me]
    );
    const lastBy = {}; last.forEach((l) => { lastBy[l.peer] = l; });

    const allUnread = await q1(
      `SELECT count(*)::int AS c FROM staff_messages m
        WHERE m.recipient_id IS NULL AND m.user_id <> $1
          AND m.id > COALESCE((SELECT last_read_id FROM staff_chat_reads r
                                WHERE r.user_id=$1 AND r.peer_key='all'), 0)`,
      [me]
    );
    const allLast = await q1(
      `SELECT m.text, m.created_at, u.full_name FROM staff_messages m
         JOIN users u ON u.id = m.user_id
        WHERE m.recipient_id IS NULL ORDER BY m.id DESC LIMIT 1`
    );

    const threads = [{
      peer_id: null, name: 'Общий чат', role: null,
      unread: allUnread ? allUnread.c : 0,
      last_text: allLast ? (allLast.full_name + ': ' + allLast.text) : null,
      last_at: allLast ? allLast.created_at : null,
    }].concat(users.map((u) => ({
      peer_id: u.id, name: u.full_name, role: u.role_code,
      unread: unreadBy[u.id] || 0,
      last_text: lastBy[u.id] ? lastBy[u.id].text : null,
      last_at: lastBy[u.id] ? lastBy[u.id].created_at : null,
    })));
    // личные — по свежести переписки, пустые в конец (по алфавиту они уже)
    const head = threads.slice(0, 1);
    const tail = threads.slice(1).sort((a, b) => String(b.last_at || '').localeCompare(String(a.last_at || '')));
    res.json(head.concat(tail));
  })
);

// GET /api/chat?peer_id=N&after_id=M&mark_read=1 — сообщения чата.
// Без peer_id — общий; с peer_id — только переписка между мной и собеседником.
chatRouter.get(
  '/',
  ah(async (req, res) => {
    const me = req.user.id;
    const peer = Number(req.query.peer_id) || null;
    const after = Number(req.query.after_id) || 0;
    const rows = peer
      ? await q(
          `SELECT m.id, m.user_id, m.text, m.created_at, u.full_name AS user_name
             FROM staff_messages m JOIN users u ON u.id = m.user_id
            WHERE m.id > $3 AND ((m.user_id=$1 AND m.recipient_id=$2) OR (m.user_id=$2 AND m.recipient_id=$1))
            ORDER BY m.id DESC LIMIT 100`,
          [me, peer, after]
        )
      : await q(
          `SELECT m.id, m.user_id, m.text, m.created_at, m.location_id,
                  u.full_name AS user_name, l.name AS location_name
             FROM staff_messages m
             JOIN users u ON u.id = m.user_id
             LEFT JOIN locations l ON l.id = m.location_id
            WHERE m.id > $1 AND m.recipient_id IS NULL
            ORDER BY m.id DESC LIMIT 100`,
          [after]
        );
    rows.reverse();
    if (req.query.mark_read && rows.length) await markRead(me, peer, rows[rows.length - 1].id);
    res.json(rows);
  })
);

// POST /api/chat/read — отметить чат прочитанным до last_id
chatRouter.post(
  '/read',
  ah(async (req, res) => {
    const { peer_id = null, last_id } = req.body || {};
    await markRead(req.user.id, Number(peer_id) || null, Number(last_id) || 0);
    res.json({ ok: true });
  })
);

chatRouter.post(
  '/',
  ah(async (req, res) => {
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинное сообщение (до 2000 символов)' });
    const recipient = Number((req.body || {}).recipient_id) || null;
    if (recipient) {
      if (recipient === req.user.id) return res.status(400).json({ error: 'Нельзя написать самому себе' });
      const u = await q1('SELECT id FROM users WHERE id=$1 AND is_active', [recipient]);
      if (!u) return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    const loc = Number((req.body || {}).location_id) || null;
    const row = await q1(
      `INSERT INTO staff_messages (user_id, text, location_id, recipient_id)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.user.id, text, loc, recipient]
    );
    // своё сообщение сразу считается прочитанным в этом чате
    await markRead(req.user.id, recipient, row.id);
    res.json({ ...row, user_id: req.user.id, text });
  })
);

// Удалить сообщение: автор — своё; в общем чате владелец — любое.
chatRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const m = await q1('SELECT * FROM staff_messages WHERE id=$1', [req.params.id]);
    if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
    const mine = m.user_id === req.user.id;
    const ownerInAll = req.user.role === 'owner' && m.recipient_id == null;
    if (!mine && !ownerInAll) return res.status(403).json({ error: 'Удалять можно только свои сообщения' });
    await q1('DELETE FROM staff_messages WHERE id=$1 RETURNING id', [m.id]);
    await audit(req, 'chat.delete', { entity: 'chat', entityId: m.id, meta: { author: m.user_id } });
    res.json({ ok: true });
  })
);
