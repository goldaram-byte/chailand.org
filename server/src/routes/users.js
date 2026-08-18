import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm, hashPassword } from '../auth.js';
import { ah, audit } from '../util.js';

export const usersRouter = Router();
usersRouter.use(requireAuth, requirePerm('users'));

// GET /api/users
usersRouter.get(
  '/',
  ah(async (req, res) => {
    const rows = await q(
      `SELECT u.id, u.full_name, u.phone, u.login, u.role_code, r.name AS role_name,
              u.is_active, u.created_at
         FROM users u JOIN roles r ON r.code = u.role_code
        ORDER BY r.sort, u.id`
    );
    res.json(rows);
  })
);

// GET /api/users/roles
usersRouter.get(
  '/roles',
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM roles ORDER BY sort'));
  })
);

// POST /api/users
usersRouter.post(
  '/',
  ah(async (req, res) => {
    const { full_name, login, password, role_code, phone } = req.body || {};
    if (!full_name || !login || !password || !role_code) {
      return res.status(400).json({ error: 'Заполните имя, логин, пароль и роль' });
    }
    const exists = await q1('SELECT id FROM users WHERE lower(login)=lower($1)', [login]);
    if (exists) return res.status(409).json({ error: 'Логин уже занят' });
    const row = await q1(
      `INSERT INTO users (full_name, phone, login, pass_hash, role_code)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, full_name, login, role_code, is_active`,
      [full_name, phone || null, login, hashPassword(password), role_code]
    );
    await audit(req, 'user.create', { entity: 'user', entityId: row.id });
    res.json(row);
  })
);

// PUT /api/users/:id
usersRouter.put(
  '/:id',
  ah(async (req, res) => {
    const { full_name, phone, role_code, is_active, password } = req.body || {};
    const row = await q1(
      `UPDATE users SET
         full_name=COALESCE($2,full_name), phone=COALESCE($3,phone),
         role_code=COALESCE($4,role_code), is_active=COALESCE($5,is_active),
         pass_hash=COALESCE($6,pass_hash), updated_at=now()
       WHERE id=$1 RETURNING id, full_name, login, role_code, is_active`,
      [req.params.id, full_name, phone, role_code, is_active, password ? hashPassword(password) : null]
    );
    await audit(req, 'user.update', { entity: 'user', entityId: req.params.id });
    res.json(row);
  })
);

// GET /api/users/audit — журнал действий (последние события)
usersRouter.get(
  '/audit',
  ah(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = await q(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.meta, a.created_at, u.full_name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(rows);
  })
);
