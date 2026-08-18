import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

// Определить тип дня для даты (учитывая праздники из настроек)
async function dayKindFor(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const holidaysRow = await q1(`SELECT value FROM settings WHERE key='holidays'`);
  const holidays = holidaysRow?.value || [];
  const iso = d.toISOString().slice(0, 10);
  if (Array.isArray(holidays) && holidays.includes(iso)) return 'weekend';
  const dow = d.getDay(); // 0=вс
  if (dow === 0 || dow === 6) return 'weekend';
  if (dow === 5) return 'friday';
  return 'weekday';
}

// GET /api/catalog — всё сразу (для загрузки кассы/настроек)
catalogRouter.get(
  '/',
  ah(async (req, res) => {
    const [groups, products, services, rooms] = await Promise.all([
      q('SELECT * FROM product_groups ORDER BY sort, id'),
      q('SELECT * FROM products ORDER BY sort, id'),
      q('SELECT * FROM services ORDER BY id'),
      q('SELECT * FROM rooms ORDER BY id'),
    ]);
    res.json({ groups, products, services, rooms, dayKind: await dayKindFor() });
  })
);

// GET /api/catalog/tariff?date=YYYY-MM-DD — актуальные билеты на дату
catalogRouter.get(
  '/tariff',
  ah(async (req, res) => {
    const kind = await dayKindFor(req.query.date);
    const products = await q(
      `SELECT p.*, g.name AS group_name FROM products p
         JOIN product_groups g ON g.id = p.group_id
        WHERE p.is_active ORDER BY p.sort, p.id`
    );
    res.json({ dayKind: kind, products });
  })
);

// ---- Управление каталогом (нужно право catalog) ----
const canEdit = requirePerm('catalog');

catalogRouter.post(
  '/groups',
  canEdit,
  ah(async (req, res) => {
    const { name, kind = 'goods', sort = 0 } = req.body || {};
    const row = await q1('INSERT INTO product_groups (name, kind, sort) VALUES ($1,$2,$3) RETURNING *', [name, kind, sort]);
    await audit(req, 'catalog.group.create', { entity: 'group', entityId: row.id });
    res.json(row);
  })
);

catalogRouter.put(
  '/groups/:id',
  canEdit,
  ah(async (req, res) => {
    const { name, kind, sort } = req.body || {};
    const row = await q1(
      `UPDATE product_groups SET name=COALESCE($2,name), kind=COALESCE($3,kind), sort=COALESCE($4,sort)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, kind, sort]
    );
    await audit(req, 'catalog.group.update', { entity: 'group', entityId: req.params.id });
    res.json(row);
  })
);

catalogRouter.delete(
  '/groups/:id',
  canEdit,
  ah(async (req, res) => {
    await q('DELETE FROM product_groups WHERE id=$1', [req.params.id]);
    await audit(req, 'catalog.group.delete', { entity: 'group', entityId: req.params.id });
    res.json({ ok: true });
  })
);

catalogRouter.post(
  '/products',
  canEdit,
  ah(async (req, res) => {
    const { group_id, name, day_kind = 'any', price = 0, requires_document = false, sort = 0, location_id = null } = req.body || {};
    const row = await q1(
      `INSERT INTO products (group_id, name, day_kind, price, requires_document, sort, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [group_id, name, day_kind, price, requires_document, sort, location_id || null]
    );
    await audit(req, 'catalog.product.create', { entity: 'product', entityId: row.id });
    res.json(row);
  })
);

catalogRouter.put(
  '/products/:id',
  canEdit,
  ah(async (req, res) => {
    const { group_id, name, day_kind, price, requires_document, is_active, location_id } = req.body || {};
    const locProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'location_id');
    const row = await q1(
      `UPDATE products SET
         group_id = COALESCE($2, group_id),
         name = COALESCE($3, name),
         day_kind = COALESCE($4, day_kind),
         price = COALESCE($5, price),
         requires_document = COALESCE($6, requires_document),
         is_active = COALESCE($7, is_active),
         location_id = CASE WHEN $8::bool THEN $9 ELSE location_id END
       WHERE id=$1 RETURNING *`,
      [req.params.id, group_id, name, day_kind, price, requires_document, is_active, locProvided, location_id || null]
    );
    await audit(req, 'catalog.product.update', { entity: 'product', entityId: req.params.id });
    res.json(row);
  })
);

catalogRouter.delete(
  '/products/:id',
  canEdit,
  ah(async (req, res) => {
    await q('DELETE FROM products WHERE id=$1', [req.params.id]);
    await audit(req, 'catalog.product.delete', { entity: 'product', entityId: req.params.id });
    res.json({ ok: true });
  })
);

catalogRouter.post(
  '/services',
  canEdit,
  ah(async (req, res) => {
    const { name, price = 0, unit = 'шт' } = req.body || {};
    const row = await q1('INSERT INTO services (name, price, unit) VALUES ($1,$2,$3) RETURNING *', [name, price, unit]);
    res.json(row);
  })
);

catalogRouter.delete(
  '/services/:id',
  canEdit,
  ah(async (req, res) => {
    await q('DELETE FROM services WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);

catalogRouter.post(
  '/rooms',
  canEdit,
  ah(async (req, res) => {
    const { name, capacity = 0 } = req.body || {};
    const row = await q1('INSERT INTO rooms (name, capacity) VALUES ($1,$2) RETURNING *', [name, capacity]);
    res.json(row);
  })
);

catalogRouter.delete(
  '/rooms/:id',
  canEdit,
  ah(async (req, res) => {
    await q('DELETE FROM rooms WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);

export { dayKindFor };
