// Точки продаж (ТЦ). Клиенты общие, касса раздельная по точкам.
// Список точек виден всем сотрудникам (нужен для привязки кассы и отчётов),
// управление — с правом 'catalog' (владелец/администратор).
import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const locationsRouter = Router();
locationsRouter.use(requireAuth);

// Список точек (для касс и отчётов)
locationsRouter.get(
  '/',
  ah(async (req, res) => {
    res.json(await q('SELECT id, name, address, active, sort, bonus_spend_percent FROM locations ORDER BY sort, id'));
  })
);

const manage = requirePerm('catalog');

locationsRouter.post(
  '/',
  manage,
  ah(async (req, res) => {
    const { name, address, sort = 0 } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Укажите название точки (ТЦ)' });
    const row = await q1(
      'INSERT INTO locations (name, address, sort) VALUES ($1,$2,$3) RETURNING *',
      [String(name).trim(), address ? String(address).trim() : null, Number(sort) || 0]
    );
    await audit(req, 'location.create', { entity: 'location', entityId: row.id });
    res.json(row);
  })
);

locationsRouter.put(
  '/:id',
  manage,
  ah(async (req, res) => {
    const { name, address, active, sort, bonus_spend_percent } = req.body || {};
    // Процент списания бонусов: 0…100
    const pct = bonus_spend_percent == null ? null : Math.max(0, Math.min(100, Number(bonus_spend_percent)));
    const row = await q1(
      `UPDATE locations SET
         name    = COALESCE(NULLIF(trim($2),''), name),
         address = COALESCE($3, address),
         active  = COALESCE($4, active),
         sort    = COALESCE($5, sort),
         bonus_spend_percent = COALESCE($6, bonus_spend_percent)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name == null ? null : String(name), address == null ? null : String(address), active, sort, pct]
    );
    if (!row) return res.status(404).json({ error: 'Точка не найдена' });
    res.json(row);
  })
);

locationsRouter.delete(
  '/:id',
  manage,
  ah(async (req, res) => {
    // Не даём удалить точку, если по ней есть продажи (историю храним).
    const used = await q1('SELECT 1 FROM sales WHERE location_id=$1 LIMIT 1', [req.params.id]);
    if (used) return res.status(409).json({ error: 'По этой точке есть продажи — её нельзя удалить. Можно отключить (active=false).' });
    await q('DELETE FROM locations WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);
