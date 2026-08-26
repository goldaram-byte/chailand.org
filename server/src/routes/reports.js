import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah } from '../util.js';

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
    const byMethod = { cash: 0, card: 0, online: 0 };
    for (const m of methods) {
      const amt = Number(m.amt);
      if (m.method === 'cash') byMethod.cash += amt;
      else if (m.method === 'online' || m.method === 'bonus') byMethod.online += amt;
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
