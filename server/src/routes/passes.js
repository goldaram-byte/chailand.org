// Абонементы в парк.
// Виды абонементов (pass_types) настраивает владелец/админ (право catalog).
// Касса (право pos) продаёт абонемент клиенту по карте и списывает посещения
// при входе. Продажа по умолчанию проводится по кассе (фискальный чек через
// createSale — попадает в смену и выручку кассира); fiscal=false — только запись.
import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createSale } from '../services/sales.js';
import { dayKindFor } from './catalog.js';

export const passesRouter = Router();
passesRouter.use(requireAuth);

const canEditTypes = requirePerm('catalog');

// Список ТЦ позиции: принимаем и новый location_ids, и старый location_id.
// Пустой список = абонемент работает во всех точках.
function locIdsFrom(body) {
  if (Array.isArray(body?.location_ids)) {
    return body.location_ids.map(Number).filter(Boolean);
  }
  if (body && body.location_id) return [Number(body.location_id)];
  if (body && Object.prototype.hasOwnProperty.call(body, 'location_id')) return [];
  return null; // поле не передали — не трогаем
}
// Работает ли абонемент в этой точке
function passWorksIn(ids, locId) {
  if (!Array.isArray(ids) || ids.length === 0) return true; // все ТЦ
  if (!locId) return false;
  return ids.map(Number).includes(Number(locId));
}
const canSell = requirePerm('pos');

// Дни действия абонемента (как у билетов): any | weekday | workweek | weekend
const PASS_DAYS = ['any', 'weekday', 'workweek', 'weekend'];
const PASS_DAYS_RU = {
  any: 'в любой день',
  weekday: 'только в будни (Пн–Чт)',
  workweek: 'только в будни и пятницу',
  weekend: 'только в выходные и праздники',
};
// Пускает ли настройка дней в день такого типа (тип дня считает dayKindFor —
// он же учитывает праздники из настроек, как у билетов).
function passDayFits(dayKind, todayKind) {
  if (!dayKind || dayKind === 'any') return true;
  if (dayKind === 'weekday') return todayKind === 'weekday';
  if (dayKind === 'workweek') return todayKind === 'weekday' || todayKind === 'friday';
  if (dayKind === 'weekend') return todayKind === 'weekend';
  return true;
}

// Режима «по числу детей» больше нет: детей в кабинет добавляют бесплатно,
// и такой лимит раздувался бы даром — абонемент оформляется на одного ребёнка.
function perDayFrom(v) {
  if (v == null || v === '') return { visits_per_day: null, per_day_kids: false };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) return false;
  return { visits_per_day: n, per_day_kids: false };
}

// ------------------------------ виды абонементов ---------------------------
passesRouter.get(
  '/types',
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM pass_types ORDER BY sort, id'));
  })
);

passesRouter.post(
  '/types',
  canEditTypes,
  ah(async (req, res) => {
    const { name, price = 0, visits = null, valid_days = 30, per_day, day_kind = 'any' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Укажите название абонемента' });
    const pd = perDayFrom(per_day);
    if (pd === false) return res.status(400).json({ error: 'Лимит в день — число от 1 до 50 или пусто (без ограничения)' });
    if (!PASS_DAYS.includes(day_kind)) return res.status(400).json({ error: 'Дни действия: любой / будни / будни+пятница / выходные' });
    const locIds = locIdsFrom(req.body) || [];
    const row = await q1(
      `INSERT INTO pass_types (name, price, visits, valid_days, location_id, location_ids, visits_per_day, per_day_kids, day_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [String(name).trim(), price, visits || null, valid_days || 30, locIds[0] || null, locIds,
       pd.visits_per_day, pd.per_day_kids, day_kind]
    );
    await audit(req, 'pass_type.create', { entity: 'pass_type', entityId: row.id });
    res.json(row);
  })
);

passesRouter.put(
  '/types/:id',
  canEditTypes,
  ah(async (req, res) => {
    const { name, price, visits, valid_days, is_active, day_kind } = req.body || {};
    const visitsProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'visits');
    const perDayProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'per_day');
    const pd = perDayProvided ? perDayFrom(req.body.per_day) : { visits_per_day: null, per_day_kids: false };
    if (pd === false) return res.status(400).json({ error: 'Лимит в день — число от 1 до 50 или пусто (без ограничения)' });
    if (day_kind != null && !PASS_DAYS.includes(day_kind)) return res.status(400).json({ error: 'Дни действия: любой / будни / будни+пятница / выходные' });
    const locIds = locIdsFrom(req.body);
    const locProvided = locIds !== null;
    const row = await q1(
      `UPDATE pass_types SET
         name = COALESCE($2, name),
         price = COALESCE($3, price),
         visits = CASE WHEN $4::bool THEN $5 ELSE visits END,
         valid_days = COALESCE($6, valid_days),
         location_id = CASE WHEN $7::bool THEN $8 ELSE location_id END,
         location_ids = CASE WHEN $7::bool THEN $9::bigint[] ELSE location_ids END,
         is_active = COALESCE($10, is_active),
         visits_per_day = CASE WHEN $11::bool THEN $12 ELSE visits_per_day END,
         per_day_kids = CASE WHEN $11::bool THEN $13 ELSE per_day_kids END,
         day_kind = COALESCE($14, day_kind)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, price, visitsProvided, visits || null, valid_days,
       locProvided, (locIds && locIds[0]) || null, locIds || [], is_active,
       perDayProvided, pd.visits_per_day, pd.per_day_kids, day_kind]
    );
    if (!row) return res.status(404).json({ error: 'Вид абонемента не найден' });
    res.json(row);
  })
);

passesRouter.delete(
  '/types/:id',
  canEditTypes,
  ah(async (req, res) => {
    await tx(async ({ q: cq }) => {
      // Проданные абонементы не трогаем — они хранят копию названия
      await cq('UPDATE passes SET pass_type_id=NULL WHERE pass_type_id=$1', [req.params.id]);
      await cq('DELETE FROM pass_types WHERE id=$1', [req.params.id]);
    });
    res.json({ ok: true });
  })
);

// ------------------------------- продажа ----------------------------------
// Обычная продажа идёт строкой чека через POST /api/pos/sales — абонемент там
// такая же позиция, как билет или товар, и выдаётся при проведении чека.
// Этот эндпоинт остаётся для служебной выдачи абонемента вне чека.
// POST /api/passes/sell { pass_type_id, client_id, method:'cash'|'card', fiscal:true, location_id }
passesRouter.post(
  '/sell',
  canSell,
  ah(async (req, res) => {
    const { pass_type_id, client_id, method = 'cash', fiscal = true, location_id = null, kid_name = null } = req.body || {};
    const type = await q1('SELECT * FROM pass_types WHERE id=$1 AND is_active', [pass_type_id]);
    if (!type) return res.status(404).json({ error: 'Вид абонемента не найден или отключён' });
    const client = await q1('SELECT id, full_name FROM clients WHERE id=$1', [client_id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден — абонемент оформляется на карту клиента' });
    if (!['cash', 'card'].includes(method)) return res.status(400).json({ error: 'Способ оплаты: наличные или карта' });

    let saleId = null;
    const price = Number(type.price);
    if (fiscal && price > 0) {
      // По кассе: фискальный чек + выручка смены. Клиент прикреплён — кэшбэк начислится.
      const sale = await createSale(req.user, {
        items: [{ name: 'Абонемент «' + type.name + '»', qty: 1, price: price }],
        cash_amount: method === 'cash' ? price : 0,
        card_amount: method === 'card' ? price : 0,
        client_id: client.id,
        location_id: location_id || type.location_id || null,
        comment: 'Продажа абонемента',
      });
      saleId = sale.id;
    }

    const typeLocs = (type.location_ids || []).map(Number);
    const pass = await q1(
      `INSERT INTO passes (pass_type_id, client_id, name, visits_total, visits_left,
                           valid_to, sale_id, location_id, location_ids, sold_by, kid_name)
       VALUES ($1,$2,$3,$4,$4, current_date + ($5 || ' days')::interval, $6, $7, $8, $9, $10) RETURNING *`,
      [type.id, client.id, type.name, type.visits || null, String(type.valid_days || 30), saleId,
       location_id || typeLocs[0] || null, typeLocs, req.user.id,
       kid_name && String(kid_name).trim() ? String(kid_name).trim() : null]
    );
    await audit(req, 'pass.sell', { entity: 'pass', entityId: pass.id, meta: { client_id: client.id, type: type.name, fiscal: !!fiscal, sale_id: saleId } });
    res.json({ ...pass, sale_id: saleId, client_name: client.full_name });
  })
);

// PUT /api/passes/:id — на кого оформлен абонемент (подпись для кассира,
// чтобы различать абонементы детей одной семьи на одной карте).
passesRouter.put(
  '/:id(\\d+)',
  canSell,
  ah(async (req, res) => {
    const has = Object.prototype.hasOwnProperty.call(req.body || {}, 'kid_name');
    if (!has) return res.status(400).json({ error: 'Укажите kid_name' });
    const v = req.body.kid_name;
    const name = v && String(v).trim() ? String(v).trim().slice(0, 80) : null;
    const row = await q1('UPDATE passes SET kid_name=$2 WHERE id=$1 RETURNING *', [req.params.id, name]);
    if (!row) return res.status(404).json({ error: 'Абонемент не найден' });
    await audit(req, 'pass.kid', { entity: 'pass', entityId: row.id, meta: { kid_name: name } });
    res.json(row);
  })
);

// ------------------------- абонементы клиента ------------------------------
passesRouter.get(
  '/by-client/:clientId',
  canSell,
  ah(async (req, res) => {
    // Лениво помечаем истёкшие
    await q(`UPDATE passes SET status='expired' WHERE client_id=$1 AND status='active' AND valid_to < current_date`, [req.params.clientId]);
    const rows = await q(
      `SELECT p.*, (SELECT count(*)::int FROM pass_visits v WHERE v.pass_id = p.id) AS visits_used,
              u.full_name AS sold_by_name, l.name AS location_name,
              -- цена именно этой позиции чека, а не всей продажи
              COALESCE(si.price, t.price) AS price, s.method AS pay_method
         FROM passes p
         LEFT JOIN users u ON u.id = p.sold_by
         LEFT JOIN locations l ON l.id = p.location_id
         LEFT JOIN sales s ON s.id = p.sale_id
         LEFT JOIN pass_types t ON t.id = p.pass_type_id
         LEFT JOIN LATERAL (
           SELECT price FROM sale_items
            WHERE sale_id = p.sale_id AND pass_type_id = p.pass_type_id
            ORDER BY id LIMIT 1
         ) si ON true
        WHERE p.client_id=$1 ORDER BY p.created_at DESC LIMIT 20`,
      [req.params.clientId]
    );
    res.json(rows);
  })
);

// --------------------------- списание посещения ----------------------------
passesRouter.post(
  '/:id/checkin',
  canSell,
  ah(async (req, res) => {
    const { location_id = null } = req.body || {};
    const result = await tx(async ({ q1: cq1 }) => {
      const p = await cq1('SELECT * FROM passes WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!p) throw Object.assign(new Error('Абонемент не найден'), { status: 404 });
      if (p.status === 'cancelled') throw Object.assign(new Error('Абонемент аннулирован'), { status: 409 });
      const today = new Date().toISOString().slice(0, 10);
      if (String(p.valid_to).slice(0, 10) < today) {
        await cq1(`UPDATE passes SET status='expired' WHERE id=$1 RETURNING id`, [p.id]);
        throw Object.assign(new Error('Срок действия абонемента истёк ' + String(p.valid_to).slice(0, 10)), { status: 409 });
      }
      if (p.status === 'used_up' || (p.visits_left != null && p.visits_left <= 0)) {
        throw Object.assign(new Error('Посещения по абонементу закончились'), { status: 409 });
      }
      // Где абонемент действует — решает НАСТРОЙКА вида абонемента, а не место
      // покупки: купили в одном ТЦ, ходить можно во всех, которым дали доступ.
      // Открыли ещё точку — уже проданные абонементы начинают работать и там.
      // Список из самого абонемента остаётся запасным на случай, если вид удалили.
      const type = p.pass_type_id
        ? await cq1('SELECT location_ids, visits_per_day, day_kind FROM pass_types WHERE id=$1', [p.pass_type_id])
        : null;
      // Дни действия: «будничный» абонемент в выходной не пускает — за это он
      // и дешевле. Тип дня считаем так же, как у билетов (учитывая праздники).
      if (type && type.day_kind && type.day_kind !== 'any') {
        const todayKind = await dayKindFor();
        if (!passDayFits(type.day_kind, todayKind)) {
          const todayRu = todayKind === 'weekend' ? 'выходной или праздник' : todayKind === 'friday' ? 'пятница' : 'будний день';
          throw Object.assign(new Error(
            'Абонемент действует ' + PASS_DAYS_RU[type.day_kind] + ', а сегодня ' + todayRu
          ), { status: 409 });
        }
      }
      const allowed = type ? type.location_ids || [] : p.location_ids || [];
      if (!passWorksIn(allowed, location_id)) {
        const names = await q(
          'SELECT name FROM locations WHERE id = ANY($1::bigint[]) ORDER BY sort, id',
          [allowed]
        );
        const where = names.map((l) => l.name).join(', ') || 'другой точке';
        throw Object.assign(new Error('Абонемент действует только в: ' + where), { status: 409 });
      }
      // Дневной лимит абонемента. Абонемент — на одного ребёнка: у семьи с
      // несколькими детьми несколько абонементов на одной карте, и каждый
      // пропускает своего. Лимит задаётся видом абонемента (обычно 1 в день).
      if (type && type.visits_per_day != null) {
        const limit = type.visits_per_day;
        const t = await cq1(
          `SELECT count(*)::int AS c FROM pass_visits WHERE pass_id=$1 AND at >= date_trunc('day', now())`,
          [p.id]
        );
        if (t.c >= limit) {
          throw Object.assign(new Error(
            'Сегодня по этому абонементу уже прошло ' + t.c + ' — лимит ' + limit + ' в день. ' +
            'На второго ребёнка нужен свой абонемент.'
          ), { status: 409 });
        }
      }
      let left = p.visits_left;
      if (left != null) {
        left -= 1;
        await cq1(
          `UPDATE passes SET visits_left=$2, status = CASE WHEN $2 <= 0 THEN 'used_up' ELSE status END WHERE id=$1 RETURNING id`,
          [p.id, left]
        );
      }
      await cq1(
        `INSERT INTO pass_visits (pass_id, by_user, location_id) VALUES ($1,$2,$3) RETURNING id`,
        [p.id, req.user.id, location_id || null]
      );
      return { id: p.id, name: p.name, visits_left: left, unlimited: p.visits_left == null, valid_to: p.valid_to };
    });
    await audit(req, 'pass.checkin', { entity: 'pass', entityId: req.params.id });
    res.json(result);
  })
);

// DELETE /api/passes/:id/visits/:visitId — отменить ошибочно списанное посещение.
// Посещение возвращается на абонемент; если он был «использован» — снова активен.
passesRouter.delete(
  '/:id/visits/:visitId',
  canSell,
  ah(async (req, res) => {
    const result = await tx(async ({ q1: cq1 }) => {
      const p = await cq1('SELECT * FROM passes WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!p) throw Object.assign(new Error('Абонемент не найден'), { status: 404 });
      const v = await cq1('SELECT * FROM pass_visits WHERE id=$1 AND pass_id=$2', [req.params.visitId, p.id]);
      if (!v) throw Object.assign(new Error('Посещение не найдено'), { status: 404 });
      await cq1('DELETE FROM pass_visits WHERE id=$1 RETURNING id', [v.id]);
      let left = p.visits_left;
      if (left != null) {
        left = Number(left) + 1;
        if (p.visits_total != null && left > Number(p.visits_total)) left = Number(p.visits_total);
      }
      // «Использован» снимаем, а истёкший по сроку так и остаётся истёкшим
      const back = await cq1(
        `UPDATE passes SET visits_left=$2,
            status = CASE WHEN status='used_up' AND valid_to >= current_date THEN 'active' ELSE status END
          WHERE id=$1 RETURNING *`,
        [p.id, left]
      );
      return back;
    });
    await audit(req, 'pass.visit.cancel', { entity: 'pass', entityId: req.params.id, meta: { visit_id: req.params.visitId } });
    res.json(result);
  })
);

// История посещений по абонементу
passesRouter.get(
  '/:id/visits',
  canSell,
  ah(async (req, res) => {
    const rows = await q(
      `SELECT v.*, u.full_name AS user_name FROM pass_visits v
         LEFT JOIN users u ON u.id = v.by_user
        WHERE v.pass_id=$1 ORDER BY v.at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json(rows);
  })
);
