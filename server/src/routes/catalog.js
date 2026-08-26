import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

// Список ТЦ позиции: пустой массив = позиция работает во всех точках.
// Принимаем и новый location_ids, и старый location_id (совместимость).
function locIdsFrom(body) {
  if (Array.isArray(body?.location_ids)) {
    const ids = body.location_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return [...new Set(ids)];
  }
  if (body?.location_id) return [Number(body.location_id)];
  return [];
}

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
    const other = await q1('SELECT id FROM product_groups WHERE id<>$1 ORDER BY sort, id LIMIT 1', [req.params.id]);
    if (!other) return res.status(409).json({ error: 'Нельзя удалить последнюю группу' });
    await tx(async ({ q: cq }) => {
      // Позиции группы не теряем — переносим в первую оставшуюся группу
      await cq('UPDATE products SET group_id=$2 WHERE group_id=$1', [req.params.id, other.id]);
      // В истории продаж группу обнуляем (сами строки продаж не трогаем)
      await cq('UPDATE sale_items SET group_id=NULL WHERE group_id=$1', [req.params.id]);
      await cq('DELETE FROM product_groups WHERE id=$1', [req.params.id]);
    });
    await audit(req, 'catalog.group.delete', { entity: 'group', entityId: req.params.id });
    res.json({ ok: true });
  })
);

catalogRouter.post(
  '/products',
  canEdit,
  ah(async (req, res) => {
    const { group_id, name, day_kind = 'any', price = 0, requires_document = false, sort = 0 } = req.body || {};
    const locIds = locIdsFrom(req.body);
    const row = await q1(
      `INSERT INTO products (group_id, name, day_kind, price, requires_document, sort, location_id, location_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [group_id, name, day_kind, price, requires_document, sort, locIds[0] || null, locIds]
    );
    await audit(req, 'catalog.product.create', { entity: 'product', entityId: row.id });
    res.json(row);
  })
);

catalogRouter.put(
  '/products/:id',
  canEdit,
  ah(async (req, res) => {
    const { group_id, name, day_kind, price, requires_document, is_active, track_stock } = req.body || {};
    const b = req.body || {};
    const locProvided = Object.prototype.hasOwnProperty.call(b, 'location_ids')
      || Object.prototype.hasOwnProperty.call(b, 'location_id');
    const locIds = locIdsFrom(b);
    const row = await q1(
      `UPDATE products SET
         group_id = COALESCE($2, group_id),
         name = COALESCE($3, name),
         day_kind = COALESCE($4, day_kind),
         price = COALESCE($5, price),
         requires_document = COALESCE($6, requires_document),
         is_active = COALESCE($7, is_active),
         location_ids = CASE WHEN $8::bool THEN $9::bigint[] ELSE location_ids END,
         location_id = CASE WHEN $8::bool THEN $10 ELSE location_id END,
         track_stock = COALESCE($11, track_stock)
       WHERE id=$1 RETURNING *`,
      [req.params.id, group_id, name, day_kind, price, requires_document, is_active,
       locProvided, locIds, locIds[0] || null, track_stock]
    );
    await audit(req, 'catalog.product.update', { entity: 'product', entityId: req.params.id });
    res.json(row);
  })
);

catalogRouter.delete(
  '/products/:id',
  canEdit,
  ah(async (req, res) => {
    await tx(async ({ q: cq }) => {
      // Позицию, которая уже продавалась, тоже можно удалить: строки чеков
      // отвязываем от неё (название и цена в них уже сохранены), поэтому
      // история продаж и отчёты не теряются.
      await cq('UPDATE sale_items SET product_id=NULL WHERE product_id=$1', [req.params.id]);
      await cq('DELETE FROM products WHERE id=$1', [req.params.id]);
    });
    await audit(req, 'catalog.product.delete', { entity: 'product', entityId: req.params.id });
    res.json({ ok: true });
  })
);

catalogRouter.post(
  '/services',
  canEdit,
  ah(async (req, res) => {
    const { name, price = 0, unit = 'шт', options = null } = req.body || {};
    const locIds = locIdsFrom(req.body);
    const row = await q1(
      'INSERT INTO services (name, price, unit, options, location_id, location_ids) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, price, unit, options, locIds[0] || null, locIds]
    );
    res.json(row);
  })
);

catalogRouter.put(
  '/services/:id',
  canEdit,
  ah(async (req, res) => {
    const { name, price, unit, options, is_active } = req.body || {};
    const b = req.body || {};
    const optProvided = Object.prototype.hasOwnProperty.call(b, 'options');
    const locProvided = Object.prototype.hasOwnProperty.call(b, 'location_ids')
      || Object.prototype.hasOwnProperty.call(b, 'location_id');
    const locIds = locIdsFrom(b);
    const row = await q1(
      `UPDATE services SET
         name = COALESCE($2, name),
         price = COALESCE($3, price),
         unit = COALESCE($4, unit),
         options = CASE WHEN $5::bool THEN $6 ELSE options END,
         is_active = COALESCE($7, is_active),
         location_ids = CASE WHEN $8::bool THEN $9::bigint[] ELSE location_ids END,
         location_id = CASE WHEN $8::bool THEN $10 ELSE location_id END
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, price, unit, optProvided, options || null, is_active,
       locProvided, locIds, locIds[0] || null]
    );
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

// ---- Учёт товаров: приход, история движений, инвентаризация ----

// POST /api/catalog/products/:id/stock  {delta, reason?, note?} — приход/корректировка
catalogRouter.post(
  '/products/:id/stock',
  canEdit,
  ah(async (req, res) => {
    const { delta, reason = 'receipt', note = null } = req.body || {};
    const d = Number(delta);
    if (!d) return res.status(400).json({ error: 'Укажите количество (не ноль)' });
    const row = await tx(async ({ q1: cq1 }) => {
      const p = await cq1(
        `UPDATE products SET track_stock=true, stock = stock + $2 WHERE id=$1 RETURNING *`,
        [req.params.id, d]
      );
      if (!p) throw Object.assign(new Error('Товар не найден'), { status: 404 });
      await cq1(
        `INSERT INTO stock_moves (product_id, delta, reason, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [req.params.id, d, reason, note, req.user.id]
      );
      return p;
    });
    await audit(req, 'stock.move', { entity: 'product', entityId: req.params.id, meta: { delta: d, reason } });
    res.json(row);
  })
);

// GET /api/catalog/products/:id/stock-moves — история движений товара
catalogRouter.get(
  '/products/:id/stock-moves',
  canEdit,
  ah(async (req, res) => {
    const rows = await q(
      `SELECT m.*, u.full_name AS user_name
         FROM stock_moves m LEFT JOIN users u ON u.id = m.created_by
        WHERE m.product_id=$1 ORDER BY m.created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// POST /api/catalog/inventory  {items:[{product_id, actual}]} — инвентаризация:
// фактический остаток заменяет учётный, разница пишется в историю движений.
catalogRouter.post(
  '/inventory',
  canEdit,
  ah(async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Пустой список инвентаризации' });
    const results = await tx(async ({ q1: cq1 }) => {
      const out = [];
      for (const it of items) {
        const actual = Number(it.actual);
        if (!it.product_id || Number.isNaN(actual)) continue;
        const p = await cq1('SELECT id, name, stock FROM products WHERE id=$1', [it.product_id]);
        if (!p) continue;
        const diff = actual - Number(p.stock);
        if (diff !== 0) {
          await cq1(
            `INSERT INTO stock_moves (product_id, delta, reason, note, created_by) VALUES ($1,$2,'inventory',$3,$4)`,
            [p.id, diff, 'Инвентаризация: было ' + p.stock + ', стало ' + actual, req.user.id]
          );
          await cq1('UPDATE products SET track_stock=true, stock=$2 WHERE id=$1', [p.id, actual]);
        }
        out.push({ product_id: p.id, name: p.name, was: Number(p.stock), now: actual, diff });
      }
      return out;
    });
    await audit(req, 'stock.inventory', { meta: { items: results.length } });
    res.json({ ok: true, results });
  })
);

catalogRouter.post(
  '/rooms',
  canEdit,
  ah(async (req, res) => {
    const { name, capacity = 0, location_id = null } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Укажите название комнаты' });
    const row = await q1('INSERT INTO rooms (name, capacity, location_id) VALUES ($1,$2,$3) RETURNING *', [String(name).trim(), capacity, location_id || null]);
    res.json(row);
  })
);

catalogRouter.put(
  '/rooms/:id',
  canEdit,
  ah(async (req, res) => {
    const { name, capacity, location_id, is_active } = req.body || {};
    const locProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'location_id');
    const row = await q1(
      `UPDATE rooms SET
         name = COALESCE($2, name),
         capacity = COALESCE($3, capacity),
         location_id = CASE WHEN $4::bool THEN $5 ELSE location_id END,
         is_active = COALESCE($6, is_active)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, capacity, locProvided, location_id || null, is_active]
    );
    res.json(row);
  })
);

catalogRouter.delete(
  '/rooms/:id',
  canEdit,
  ah(async (req, res) => {
    await tx(async ({ q: cq }) => {
      // Брони не удаляем — отвязываем от комнаты, они остаются в журнале
      await cq('UPDATE bookings SET room_id=NULL WHERE room_id=$1', [req.params.id]);
      await cq('DELETE FROM rooms WHERE id=$1', [req.params.id]);
    });
    res.json({ ok: true });
  })
);

export { dayKindFor };
