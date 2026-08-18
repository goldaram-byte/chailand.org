import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from './env.js';
import { q1 } from './db.js';

// Полный набор разрешений. Роль owner получает '*' (всё).
export const ALL_PERMS = [
  'pos',        // касса: продажи
  'returns',    // оформление возвратов
  'shifts',     // открытие/закрытие смены
  'clients',    // клиентская база
  'crm',        // воронка продаж
  'bookings',   // праздники
  'reports',    // отчёты и дашборд
  'catalog',    // тарифы/товары/услуги
  'news',       // новости парка (публикация для клиентов)
  'settings',   // настройки
  'users',      // управление сотрудниками
  'acquiring',  // эквайринг
  'fiscal',     // фискализация
];

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

/** Итоговые разрешения пользователя: переопределение > разрешения роли. */
export function effectivePerms(user) {
  const raw = user.perm_override ?? user.role_permissions ?? [];
  if (Array.isArray(raw) && raw.includes('*')) return ['*'];
  return Array.isArray(raw) ? raw : [];
}

export function hasPerm(perms, perm) {
  return perms.includes('*') || perms.includes(perm);
}

export function signToken(user) {
  const perms = effectivePerms(user);
  return jwt.sign(
    {
      sub: String(user.id),
      name: user.full_name,
      role: user.role_code,
      perms,
    },
    env.jwtSecret,
    { expiresIn: env.jwtTtl }
  );
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.cookies && req.cookies.token) return req.cookies.token;
  return null;
}

// ---- Клиентское приложение (личный кабинет) ----
// Токен клиента помечается typ:'client', чтобы его нельзя было использовать
// как токен сотрудника (и наоборот).
export function signClientToken(client) {
  return jwt.sign(
    { sub: String(client.id), typ: 'client', name: client.full_name },
    env.jwtSecret,
    { expiresIn: '30d' }
  );
}

/** Требует валидный токен клиента; кладёт req.client = {id, name}. */
export async function requireClient(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Требуется вход' });
    const payload = jwt.verify(token, env.jwtSecret);
    if (payload.typ !== 'client') return res.status(401).json({ error: 'Недействительный токен' });
    const client = await q1('SELECT id, full_name FROM clients WHERE id = $1', [Number(payload.sub)]);
    if (!client) return res.status(401).json({ error: 'Профиль недоступен' });
    req.client = { id: client.id, name: client.full_name };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

/** Требует валидный токен; кладёт req.user = {id,name,role,perms}. */
export async function requireAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
    const payload = jwt.verify(token, env.jwtSecret);
    // Клиентский токен (личный кабинет) не даёт доступа к панели сотрудника.
    if (payload.typ === 'client') return res.status(401).json({ error: 'Недействительный токен' });
    // Проверяем, что пользователь ещё активен
    const user = await q1(
      'SELECT id, full_name, role_code, is_active FROM users WHERE id = $1',
      [Number(payload.sub)]
    );
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Учётная запись недоступна' });
    }
    req.user = {
      id: user.id,
      name: user.full_name,
      role: user.role_code,
      perms: Array.isArray(payload.perms) ? payload.perms : [],
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

/** Middleware-фабрика: требует конкретное разрешение. */
export function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
    if (!hasPerm(req.user.perms, perm)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}
