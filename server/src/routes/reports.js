import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requirePerm('reports'));

// GET /api/reports/kpi?period= — показатели по сотрудникам кассы + цели (KPI)
reportsRouter.get(
  '/kpi',
  ah(async (req, res) => {
    const params = [];
    let cond;
    if (req.query.from && req.query.to) {
      params.push(req.query.from, req.query.to + ' 23:59:59');
      cond = `s.created_at >= $${params.length - 1} AND s.created_at <= $${params.length}`;
    } else {
      const map = {
        today: `s.created_at >= date_trunc('day', now())`,
        '7': `s.created_at >= now() - interval '6 days'`,
        '30': `s.created_at >= now() - interval '29 days'`,
        week: `s.created_at >= date_trunc('week', now())`,
        month: `s.created_at >= date_trunc('month', now())`,
        all: 'true',
      };
      cond = map[req.query.period] || map.month;
    }
    // Фильтр по точке (ТЦ)
    if (req.query.location_id && req.query.location_id !== 'all') {
      params.push(Number(req.query.location_id));
      cond += ` AND s.location_id = $${params.length}`;
    }
    const rows = await q(
      `SELECT u.id, u.full_name, u.role_code,
              COALESCE(SUM(s.total) FILTER (WHERE NOT s.is_return),0) AS revenue,
              count(s.id) FILTER (WHERE NOT s.is_return) AS checks,
              count(s.id) FILTER (WHERE s.is_return) AS returns,
              COALESCE(SUM(s.bonus_earned) FILTER (WHERE NOT s.is_return),0) AS bonus_earned
         FROM users u
         LEFT JOIN sales s ON s.cashier_id = u.id AND (${cond})
        WHERE u.is_active
        GROUP BY u.id, u.full_name, u.role_code
        ORDER BY revenue DESC`,
      params
    );
    const t = await q1(`SELECT value FROM settings WHERE key='kpi_targets'`);
    const targets = t?.value || {};
    res.json({
      period: req.query.period || `${req.query.from}…${req.query.to}`,
      targets,
      staff: rows.map((r) => ({
        id: r.id,
        name: r.full_name,
        role: r.role_code,
        revenue: Number(r.revenue),
        checks: r.checks,
        returns: r.returns,
        bonus_earned: Number(r.bonus_earned),
        avg_check: r.checks ? Math.round(Number(r.revenue) / r.checks) : 0,
      })),
    });
  })
);

// План KPI одного парка: настройка kpi_plans = { "<location_id>": {...} }.
// Если для парка план ещё не задан — берём старый общий план kpi_goals
// (он был один на все парки), премия при этом не считается.
function planFor(plans, legacy, locId) {
  const p = (locId != null && plans[String(locId)]) || null;
  const src = p || legacy || {};
  const num = (v) => Math.max(0, Math.round(Number(v) || 0));
  return {
    bookings: num(src.bookings), passes: num(src.passes), water: num(src.water),
    bonus_pct: p ? Math.max(0, Number(p.bonus_pct) || 0) : 0,
    bonus_pct_over: p ? Math.max(0, Number(p.bonus_pct_over) || 0) : 0,
    set: !!p,
  };
}

// Премия за праздники: план выполнен (броней не меньше плана) — bonus_pct от
// суммы броней парка за месяц; перевыполнен (броней больше плана) — bonus_pct_over.
function bookingBonus(plan, n, sum) {
  if (!plan || !plan.bookings || n < plan.bookings) return { bonus: 0, pct: 0, state: plan && plan.bookings ? 'below' : 'none' };
  const over = n > plan.bookings;
  const pct = over ? (plan.bonus_pct_over || plan.bonus_pct) : plan.bonus_pct;
  return { bonus: Math.round(Number(sum) * pct / 100), pct, state: over ? 'over' : 'done' };
}

async function loadPlans() {
  const rows = await q(`SELECT key, value FROM settings WHERE key IN ('kpi_plans','kpi_goals')`);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const plans = m.kpi_plans && typeof m.kpi_plans === 'object' ? m.kpi_plans : {};
  const legacy = m.kpi_goals && typeof m.kpi_goals === 'object' ? m.kpi_goals : null;
  return { plans, legacy };
}

// PUT /api/reports/kpi-plans/:location_id — план и проценты премии для парка
// (владелец/админ). Хранится в settings.kpi_plans, остальные парки не трогаем.
reportsRouter.put(
  '/kpi-plans/:location_id',
  requirePerm('settings'),
  ah(async (req, res) => {
    const locId = Number(req.params.location_id);
    const loc = await q1(`SELECT id, name FROM locations WHERE id=$1`, [locId]);
    if (!loc) return res.status(404).json({ error: 'Парк не найден' });
    const b = req.body || {};
    const num = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));
    const pct = (v) => Math.min(100, Math.max(0, Math.round((Number(v) || 0) * 10) / 10));
    const plan = {
      bookings: num(b.bookings, 100000), passes: num(b.passes, 100000), water: num(b.water, 1000000),
      bonus_pct: pct(b.bonus_pct), bonus_pct_over: pct(b.bonus_pct_over),
    };
    const { plans } = await loadPlans();
    plans[String(locId)] = plan;
    await q(
      `INSERT INTO settings (key, value) VALUES ('kpi_plans', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(plans)]
    );
    await audit(req, 'kpi.plan', { meta: { location_id: locId, ...plan } });
    res.json({ ok: true, location_id: locId, plan });
  })
);

// GET /api/reports/kpi-cashiers?month=YYYY-MM[&location_id=]
// KPI кассиров за месяц: праздники (брони, где сотрудник — продавец),
// абонементы (выданные, таблица passes) и вода (товары с галочкой
// «Вода (KPI)»). План — отдельный на каждый парк (settings.kpi_plans),
// премия — процент от суммы броней парка при выполнении/перевыполнении плана.
// Без location_id (все парки) премия складывается по паркам, единого плана нет.
// Кассир видит только свою строку, владелец и администратор — всех.
reportsRouter.get(
  '/kpi-cashiers',
  ah(async (req, res) => {
    const m = String(req.query.month || '').match(/^(\d{4})-(\d{2})$/);
    const now = new Date();
    const y = m ? Number(m[1]) : now.getFullYear();
    const mo = m ? Number(m[2]) : now.getMonth() + 1;
    const from = `${y}-${String(mo).padStart(2, '0')}-01`;
    const to = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    const params = [from, to];
    let locSale = '', locBook = '', locPass = '';
    const locId = req.query.location_id && req.query.location_id !== 'all' ? Number(req.query.location_id) : null;
    if (locId) {
      params.push(locId);
      locSale = ` AND s.location_id = $3`;
      locBook = ` AND b.location_id = $3`;
      locPass = ` AND p.location_id = $3`;
    }
    const onlyMe = !['owner', 'admin'].includes(req.user.role);
    const { plans, legacy } = await loadPlans();
    const locs = await q(`SELECT id, name FROM locations ORDER BY id`);
    const locName = (id) => (locs.find((l) => l.id === Number(id)) || {}).name || 'Без парка';
    // брони по паркам — для премии (план у каждого парка свой)
    const byLoc = await q(
      `SELECT b.seller_id AS uid, b.location_id, count(*)::int AS n, COALESCE(SUM(b.total), 0) AS sum
         FROM bookings b
        WHERE b.status <> 'cancelled' AND b.created_at >= $1 AND b.created_at < $2${locBook}
        GROUP BY b.seller_id, b.location_id`,
      params
    );
    const rows = await q(
      `SELECT u.id, u.full_name, u.role_code, u.is_active,
              COALESCE(bk.n, 0)::int AS bookings, COALESCE(bk.sum, 0) AS bookings_sum,
              COALESCE(ps.n, 0)::int AS passes,   COALESCE(ps.sum, 0) AS passes_sum,
              COALESCE(wt.n, 0)::int AS water,    COALESCE(wt.sum, 0) AS water_sum,
              COALESCE(ch.n, 0)::int AS checks,   COALESCE(ch.sum, 0) AS revenue
         FROM users u
         LEFT JOIN (SELECT b.seller_id AS uid, count(*) AS n, SUM(b.total) AS sum
                      FROM bookings b
                     WHERE b.status <> 'cancelled' AND b.created_at >= $1 AND b.created_at < $2${locBook}
                     GROUP BY b.seller_id) bk ON bk.uid = u.id
         -- абонементы считаем по выданным (таблица passes): так учитываются и
         -- продажа кнопкой «Абонемент», и абонемент позицией в обычном чеке
         LEFT JOIN (SELECT p.sold_by AS uid, count(*) AS n, COALESCE(SUM(pt.price), 0) AS sum
                      FROM passes p LEFT JOIN pass_types pt ON pt.id = p.pass_type_id
                     WHERE p.status <> 'cancelled' AND p.created_at >= $1 AND p.created_at < $2${locPass}
                     GROUP BY p.sold_by) ps ON ps.uid = u.id
         LEFT JOIN (SELECT s.cashier_id AS uid, SUM(i.qty) AS n, SUM(i.sum) AS sum
                      FROM sale_items i JOIN sales s ON s.id = i.sale_id
                      JOIN products p ON p.id = i.product_id
                     WHERE p.kpi_water AND NOT s.is_return
                       AND s.created_at >= $1 AND s.created_at < $2${locSale}
                     GROUP BY s.cashier_id) wt ON wt.uid = u.id
         LEFT JOIN (SELECT s.cashier_id AS uid, count(*) AS n, SUM(s.total) AS sum
                      FROM sales s
                     WHERE NOT s.is_return AND s.created_at >= $1 AND s.created_at < $2${locSale}
                     GROUP BY s.cashier_id) ch ON ch.uid = u.id
        -- уволенных показываем, только если в этом месяце у них были продажи:
        -- иначе «Итого» не сойдётся с приходами за месяц
        WHERE (u.is_active OR bk.n IS NOT NULL OR ps.n IS NOT NULL OR wt.n IS NOT NULL OR ch.n IS NOT NULL)
          ${onlyMe ? 'AND u.id = ' + Number(req.user.id) : ''}
        ORDER BY (COALESCE(bk.n,0) + COALESCE(ps.n,0) + COALESCE(wt.n,0)) DESC, u.full_name`,
      params
    );
    const goals = locId ? planFor(plans, legacy, locId) : null;
    const isBoss = !onlyMe;
    res.json({
      month: `${y}-${String(mo).padStart(2, '0')}`,
      location_id: locId,
      goals,
      // планы всех парков — только руководству (для формы настройки)
      plans: isBoss ? Object.fromEntries(locs.map((l) => [l.id, planFor(plans, legacy, l.id)])) : undefined,
      staff: rows.map((r) => {
        const parts = byLoc
          .filter((x) => Number(x.uid) === Number(r.id))
          .map((x) => {
            const plan = x.location_id ? planFor(plans, legacy, x.location_id) : null;
            const bb = bookingBonus(plan, x.n, x.sum);
            return { location_id: x.location_id, location: locName(x.location_id), bookings: x.n, bookings_sum: Number(x.sum),
                     plan: plan ? plan.bookings : 0, pct: bb.pct, state: bb.state, bonus: bb.bonus };
          });
        // в режиме одного парка премия считается по его плану, даже если броней нет
        const single = locId ? (parts[0] || { ...bookingBonus(goals, 0, 0), pct: 0, bonus: 0 }) : null;
        return {
          id: r.id, name: r.full_name, role: r.role_code, active: r.is_active,
          bookings: r.bookings, bookings_sum: Number(r.bookings_sum),
          passes: r.passes, passes_sum: Number(r.passes_sum),
          water: r.water, water_sum: Number(r.water_sum),
          checks: r.checks, revenue: Number(r.revenue),
          bonus: parts.reduce((a, x) => a + x.bonus, 0),
          bonus_pct: single ? single.pct : null,
          bonus_state: single ? single.state : null,
          bonus_by_loc: parts,
        };
      }),
    });
  })
);

// Разобрать период: ?from=YYYY-MM-DD&to=YYYY-MM-DD или ?period=today|week|month
function resolvePeriod(query) {
  if (query.from && query.to) return { from: query.from, to: query.to + ' 23:59:59' };
  const p = query.period || 'today';
  // Диапазоны считаем в SQL через now(); здесь возвращаем маркер
  return { preset: p };
}

function whereClause(period, params) {
  if (period.from) {
    params.push(period.from, period.to);
    return `created_at >= $${params.length - 1} AND created_at <= $${params.length}`;
  }
  const map = {
    today: `created_at >= date_trunc('day', now())`,
    week: `created_at >= date_trunc('week', now())`,
    month: `created_at >= date_trunc('month', now())`,
    year: `created_at >= date_trunc('year', now())`,
    all: `true`,
  };
  return map[period.preset] || map.today;
}

// GET /api/reports/dashboard
reportsRouter.get(
  '/dashboard',
  ah(async (req, res) => {
    const period = resolvePeriod(req.query);
    const params = [];
    const where = whereClause(period, params);

    const summary = await q1(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE NOT is_return),0) AS revenue,
         COALESCE(SUM(total) FILTER (WHERE is_return),0) AS returns_sum,
         COALESCE(SUM(cash_amount),0) AS cash,
         COALESCE(SUM(card_amount),0) AS card,
         COALESCE(SUM(bonus_used),0) AS bonus_used,
         COALESCE(SUM(bonus_earned),0) AS bonus_earned,
         count(*) FILTER (WHERE NOT is_return) AS checks,
         count(*) FILTER (WHERE is_return) AS returns_count
       FROM sales WHERE ${where}`,
      params
    );
    const avg = summary.checks > 0 ? Math.round(summary.revenue / summary.checks) : 0;
    res.json({ period: period.preset || `${req.query.from}…${req.query.to}`, ...summary, avg_check: avg });
  })
);

// GET /api/reports/top-positions?period=&group_id=&limit=  (как в Эвотор: по количеству, по убыванию)
reportsRouter.get(
  '/top-positions',
  ah(async (req, res) => {
    const period = resolvePeriod(req.query);
    const params = [];
    const where = whereClause(period, params);
    let groupFilter = '';
    if (req.query.group_id) {
      params.push(req.query.group_id);
      groupFilter = ` AND i.group_id = $${params.length}`;
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    params.push(limit);
    const rows = await q(
      `SELECT i.name,
              SUM(i.qty) AS qty,
              SUM(i.sum) AS revenue,
              count(DISTINCT s.id) AS checks
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE ${where} AND NOT s.is_return ${groupFilter}
        GROUP BY i.name
        ORDER BY qty DESC
        LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  })
);

// GET /api/reports/by-group?period=
reportsRouter.get(
  '/by-group',
  ah(async (req, res) => {
    const period = resolvePeriod(req.query);
    const params = [];
    const where = whereClause(period, params);
    const rows = await q(
      `SELECT COALESCE(g.name,'Прочее') AS group_name,
              SUM(i.qty) AS qty, SUM(i.sum) AS revenue
         FROM sale_items i
         JOIN sales s ON s.id = i.sale_id
         LEFT JOIN product_groups g ON g.id = i.group_id
        WHERE ${where} AND NOT s.is_return
        GROUP BY g.name
        ORDER BY revenue DESC`,
      params
    );
    res.json(rows);
  })
);

// Единый фильтр для дашборда: период + группа + способ оплаты + кассир.
// Всё считается по позициям (sale_items), поэтому фильтр по группе корректен.
function buildOverviewFilters(query) {
  const params = [];
  const conds = ['NOT s.is_return'];
  if (query.from && query.to) {
    params.push(query.from, query.to + ' 23:59:59');
    conds.push(`s.created_at >= $${params.length - 1} AND s.created_at <= $${params.length}`);
  } else {
    const map = {
      today: `s.created_at >= date_trunc('day', now())`,
      '7': `s.created_at >= now() - interval '6 days'`,
      '30': `s.created_at >= now() - interval '29 days'`,
      week: `s.created_at >= date_trunc('week', now())`,
      month: `s.created_at >= date_trunc('month', now())`,
      all: 'true',
    };
    conds.push(map[query.period] || map['30']);
  }
  if (query.group_id && query.group_id !== 'all') {
    params.push(query.group_id);
    conds.push(`i.group_id = $${params.length}`);
  }
  if (query.item && query.item !== 'all') {
    params.push(query.item);
    conds.push(`i.name = $${params.length}`);
  }
  if (query.method && query.method !== 'all') {
    params.push(query.method);
    conds.push(`s.method = $${params.length}`);
  }
  if (query.cashier_id && query.cashier_id !== 'all') {
    params.push(query.cashier_id);
    conds.push(`s.cashier_id = $${params.length}`);
  }
  // Фильтр по точке (ТЦ). 'all' — все точки вместе.
  if (query.location_id && query.location_id !== 'all') {
    params.push(query.location_id);
    conds.push(`s.location_id = $${params.length}`);
  }
  return { where: conds.join(' AND '), params };
}

// GET /api/reports/cashiers — список кассиров для фильтра дашборда
reportsRouter.get(
  '/cashiers',
  ah(async (req, res) => {
    res.json(await q('SELECT id, full_name FROM users WHERE is_active ORDER BY id'));
  })
);

// GET /api/reports/overview — сводка дашборда одним запросом (KPI + топ + оплата)
reportsRouter.get(
  '/overview',
  ah(async (req, res) => {
    const { where, params } = buildOverviewFilters(req.query);
    const base = `FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${where}`;
    const [kpi, methods, top] = await Promise.all([
      q1(`SELECT COALESCE(SUM(i.sum),0) AS revenue, COALESCE(SUM(i.qty),0) AS qty, count(DISTINCT s.id) AS checks ${base}`, params),
      q(`SELECT s.method, COALESCE(SUM(i.sum),0) AS amt ${base} GROUP BY s.method`, params),
      q(`SELECT i.name, SUM(i.qty) AS qty, SUM(i.sum) AS amt ${base} GROUP BY i.name ORDER BY qty DESC LIMIT 50`, params),
    ]);
    const byMethod = { cash: 0, card: 0, online: 0, transfer: 0 };
    for (const m of methods) {
      const amt = Number(m.amt);
      if (m.method === 'cash') byMethod.cash += amt;
      else if (m.method === 'online' || m.method === 'bonus') byMethod.online += amt;
      else if (m.method === 'transfer') byMethod.transfer += amt;
      else byMethod.card += amt; // card, mixed
    }
    const revenue = Number(kpi.revenue);
    res.json({
      revenue,
      qty: Number(kpi.qty),
      checks: kpi.checks,
      avg: kpi.checks ? Math.round(revenue / kpi.checks) : 0,
      byMethod,
      top: top.map((t) => ({ name: t.name, qty: Number(t.qty), amt: Number(t.amt) })),
    });
  })
);

// GET /api/reports/sales-by-day?days=30 — для графика выручки
reportsRouter.get(
  '/sales-by-day',
  ah(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 180);
    const rows = await q(
      `SELECT to_char(date_trunc('day', created_at),'YYYY-MM-DD') AS day,
              SUM(total) FILTER (WHERE NOT is_return) AS revenue,
              count(*) FILTER (WHERE NOT is_return) AS checks
         FROM sales
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [days]
    );
    res.json(rows);
  })
);
