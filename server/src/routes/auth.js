import { Router } from 'express';
import { q1 } from '../db.js';
import {
  checkPassword,
  signToken,
  requireAuth,
  effectivePerms,
} from '../auth.js';
import { ah, audit } from '../util.js';

export const authRouter = Router();

// POST /api/auth/login  { login, password }
authRouter.post(
  '/login',
  ah(async (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) {
      return res.status(400).json({ error: 'Укажите логин и пароль' });
    }
    const user = await q1(
      `SELECT u.*, r.permissions AS role_permissions, r.name AS role_name
         FROM users u JOIN roles r ON r.code = u.role_code
        WHERE lower(u.login) = lower($1)`,
      [login]
    );
    if (!user || !user.is_active || !checkPassword(password, user.pass_hash)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const perms = effectivePerms(user);
    const token = signToken(user);
    await audit({ user: { id: user.id }, ip: req.ip }, 'auth.login', {
      entity: 'user',
      entityId: user.id,
    });
    res.json({
      token,
      user: {
        id: user.id,
        name: user.full_name,
        role: user.role_code,
        roleName: user.role_name,
        perms,
      },
    });
  })
);

// GET /api/auth/me
authRouter.get(
  '/me',
  requireAuth,
  ah(async (req, res) => {
    const user = await q1(
      `SELECT u.*, r.permissions AS role_permissions, r.name AS role_name
         FROM users u JOIN roles r ON r.code = u.role_code
        WHERE u.id = $1`,
      [req.user.id]
    );
    if (!user || !user.is_active) return res.status(401).json({ error: 'Учётная запись отключена' });
    // Скользящая сессия: пока сотрудник работает, отдаём свежий токен.
    // Иначе смена длиннее срока токена заканчивалась выходом из аккаунта
    // прямо на кассе — при первом же обновлении страницы.
    res.json({
      id: user.id,
      name: user.full_name,
      phone: user.phone,
      role: user.role_code,
      roleName: user.role_name,
      perms: effectivePerms(user),
      token: signToken(user),
    });
  })
);
