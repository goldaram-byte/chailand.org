import { q } from './db.js';

/** Оборачивает async-обработчик, пробрасывая ошибки в next(). */
export function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Запись в журнал действий. Не бросает ошибку наружу. */
export async function audit(req, action, { entity, entityId, meta } = {}) {
  try {
    await q(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.user?.id ?? null,
        action,
        entity ?? null,
        entityId != null ? String(entityId) : null,
        meta ? JSON.stringify(meta) : '{}',
        req.ip ?? null,
      ]
    );
  } catch (err) {
    console.error('[audit] не удалось записать', action, err.message);
  }
}
