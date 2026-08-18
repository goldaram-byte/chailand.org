// СКУД — учёт рабочего времени персонала (приход/уход).
// Отметка приходит с терминала отпечатков пальца (POST /punch с fingerprint_id)
// либо вносится вручную. Данные видят администратор и владелец (право 'skud').
import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const skudRouter = Router();

// ---- Персонал (CRUD) — только с правом 'skud' ----
const guard = [requireAuth, requirePerm('skud')];

skudRouter.get(
  '/personnel',
  guard,
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM personnel ORDER BY active DESC, full_name'));
  })
);

skudRouter.post(
  '/personnel',
  guard,
  ah(async (req, res) => {
    const { full_name, position, phone, fingerprint_id, user_id } = req.body || {};
    if (!full_name || !full_name.trim()) return res.status(400).json({ error: 'Укажите имя сотрудника' });
    const row = await q1(
      `INSERT INTO personnel (full_name, position, phone, fingerprint_id, user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [full_name.trim(), position || null, phone || null, fingerprint_id || null, user_id || null]
    );
    await audit(req, 'skud.personnel.create', { entity: 'personnel', entityId: row.id });
    res.json(row);
  })
);

skudRouter.put(
  '/personnel/:id',
  guard,
  ah(async (req, res) => {
    const { full_name, position, phone, fingerprint_id, active, hourly_rate } = req.body || {};
    const row = await q1(
      `UPDATE personnel SET
         full_name = COALESCE($2, full_name),
         position = COALESCE($3, position),
         phone = COALESCE($4, phone),
         fingerprint_id = COALESCE($5, fingerprint_id),
         active = COALESCE($6, active),
         hourly_rate = COALESCE($7, hourly_rate)
       WHERE id=$1 RETURNING *`,
      [req.params.id, full_name, position, phone, fingerprint_id, active, hourly_rate]
    );
    res.json(row);
  })
);

skudRouter.delete(
  '/personnel/:id',
  guard,
  ah(async (req, res) => {
    await q('DELETE FROM personnel WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---- Кто сейчас на смене (последняя отметка = вход) ----
skudRouter.get(
  '/status',
  guard,
  ah(async (req, res) => {
    const rows = await q(
      `SELECT p.id, p.full_name, p.position, p.active,
              a.direction AS last_direction, a.at AS last_at
         FROM personnel p
         LEFT JOIN LATERAL (
           SELECT direction, at FROM attendance WHERE personnel_id = p.id ORDER BY at DESC LIMIT 1
         ) a ON true
        ORDER BY (a.direction='in') DESC NULLS LAST, p.full_name`
    );
    res.json(rows.map((r) => ({ ...r, on_shift: r.last_direction === 'in' })));
  })
);

// ---- Журнал отметок ----
skudRouter.get(
  '/log',
  guard,
  ah(async (req, res) => {
    const { from, to, personnel_id } = req.query;
    const p = [];
    const where = [];
    const add = (v) => { p.push(v); return '$' + p.length; };
    if (from) where.push(`a.at >= ${add(from)}`);
    if (to) where.push(`a.at < (${add(to)}::date + 1)`);
    if (personnel_id) where.push(`a.personnel_id = ${add(personnel_id)}`);
    const rows = await q(
      `SELECT a.*, pe.full_name, pe.position
         FROM attendance a JOIN personnel pe ON pe.id = a.personnel_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.at DESC LIMIT 1000`,
      p
    );
    res.json(rows);
  })
);

// ---- Табель: часы по каждому сотруднику за период ----
skudRouter.get(
  '/timesheet',
  guard,
  ah(async (req, res) => {
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || to;
    const rows = await q(
      `SELECT a.personnel_id, pe.full_name, pe.position, pe.hourly_rate, a.direction, a.at
         FROM attendance a JOIN personnel pe ON pe.id = a.personnel_id
        WHERE a.at >= $1::date AND a.at < ($2::date + 1)
        ORDER BY a.personnel_id, a.at`,
      [from, to]
    );
    // Плановые часы из графика за период
    const planRows = await q(
      `SELECT personnel_id, COALESCE(sum(planned_hours),0) AS ph
         FROM work_schedule WHERE work_date >= $1 AND work_date <= $2 GROUP BY personnel_id`,
      [from, to]
    );
    const planned = {};
    for (const p of planRows) planned[p.personnel_id] = Number(p.ph);

    // Рабочее окно для расчёта ЗП: по умолчанию 10:00–22:00 (МСК, смещение +3).
    // Часы вне окна (пришёл раньше / ушёл позже) в оплату не идут.
    const wcfg = {};
    for (const r of await q(`SELECT key, value FROM settings WHERE key IN ('payroll_window_start','payroll_window_end','payroll_tz_offset')`)) {
      wcfg[r.key] = typeof r.value === 'string' ? r.value.replace(/^"|"$/g, '') : r.value;
    }
    const toMin = (s, d) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? (+m[1] * 60 + +m[2]) : d; };
    const winStartMin = toMin(wcfg.payroll_window_start, 600);   // 10:00
    const winEndMin = toMin(wcfg.payroll_window_end, 1320);      // 22:00
    const offH = Number(wcfg.payroll_tz_offset != null ? wcfg.payroll_tz_offset : 3);
    function workedMin(inISO, outISO) {
      const inMs = new Date(inISO).getTime(), outMs = new Date(outISO).getTime();
      const localMidnightUtc = Math.floor((inMs + offH * 3600000) / 86400000) * 86400000 - offH * 3600000;
      const s = Math.max(inMs, localMidnightUtc + winStartMin * 60000);
      const e = Math.min(outMs, localMidnightUtc + winEndMin * 60000);
      return Math.max(0, Math.round((e - s) / 60000));
    }

    // Пары вход→выход по каждому сотруднику и дню
    const byPerson = {};
    for (const r of rows) {
      const key = r.personnel_id;
      (byPerson[key] ||= { personnel_id: key, full_name: r.full_name, position: r.position, rate: Number(r.hourly_rate || 0), days: {}, total_min: 0 });
    }
    // проходим последовательно, держим открытый вход
    const openIn = {};
    for (const r of rows) {
      const pid = r.personnel_id;
      const day = new Date(r.at).toISOString().slice(0, 10);
      const acc = byPerson[pid];
      acc.days[day] ||= { date: day, first_in: null, last_out: null, worked_min: 0 };
      if (r.direction === 'in') {
        openIn[pid] = r.at;
        if (!acc.days[day].first_in) acc.days[day].first_in = r.at;
      } else if (r.direction === 'out') {
        acc.days[day].last_out = r.at;
        if (openIn[pid]) {
          const mins = workedMin(openIn[pid], r.at);
          acc.days[day].worked_min += mins;
          acc.total_min += mins;
          openIn[pid] = null;
        }
      }
    }
    const result = Object.values(byPerson).map((p) => {
      const hours = Math.round((p.total_min / 60) * 10) / 10;
      return {
        personnel_id: p.personnel_id,
        full_name: p.full_name,
        position: p.position,
        rate: p.rate,
        total_min: p.total_min,
        total_hours: hours,
        planned_hours: planned[p.personnel_id] || 0,
        salary: Math.round(hours * p.rate),
        days: Object.values(p.days).sort((a, b) => a.date.localeCompare(b.date)),
      };
    });
    const payroll_total = result.reduce((a, s) => a + s.salary, 0);
    res.json({ from, to, payroll_total, staff: result.sort((a, b) => a.full_name.localeCompare(b.full_name)) });
  })
);

// ---- График работы (плановая сетка) ----
skudRouter.get(
  '/schedule',
  guard,
  ah(async (req, res) => {
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    const from = req.query.from || to;
    const rows = await q(
      `SELECT id, personnel_id, work_date, planned_hours, note
         FROM work_schedule WHERE work_date >= $1 AND work_date <= $2
        ORDER BY personnel_id, work_date`,
      [from, to]
    );
    res.json(rows);
  })
);

// Установить/обновить плановые часы в ячейке графика (upsert). planned_hours=0 удаляет.
skudRouter.post(
  '/schedule',
  guard,
  ah(async (req, res) => {
    const { personnel_id, work_date, planned_hours = 0, note } = req.body || {};
    if (!personnel_id || !work_date) return res.status(400).json({ error: 'Нужны personnel_id и work_date' });
    const h = Number(planned_hours) || 0;
    if (h <= 0) {
      await q('DELETE FROM work_schedule WHERE personnel_id=$1 AND work_date=$2', [personnel_id, work_date]);
      return res.json({ ok: true, removed: true });
    }
    const row = await q1(
      `INSERT INTO work_schedule (personnel_id, work_date, planned_hours, note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (personnel_id, work_date)
       DO UPDATE SET planned_hours = EXCLUDED.planned_hours, note = EXCLUDED.note
       RETURNING *`,
      [personnel_id, work_date, h, note || null]
    );
    res.json(row);
  })
);

// ---- Отметка прихода/ухода ----
// Терминал отпечатков шлёт fingerprint_id + токен устройства (заголовок
// X-Device-Token = settings.skud_device_token). Ручная отметка — с правом 'skud'.
async function punchAuth(req, res, next) {
  const token = req.get('X-Device-Token');
  if (token) {
    const row = await q1(`SELECT value FROM settings WHERE key='skud_device_token'`);
    const expected = row?.value ? (typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : row.value) : '';
    if (expected && token === expected) { req.viaDevice = true; return next(); }
    return res.status(401).json({ error: 'Неверный токен устройства' });
  }
  // иначе — обычная авторизация сотрудника с правом skud
  return requireAuth(req, res, () => requirePerm('skud')(req, res, next));
}

skudRouter.post(
  '/punch',
  punchAuth,
  ah(async (req, res) => {
    const { fingerprint_id, personnel_id, direction, device_id } = req.body || {};
    let person = null;
    if (personnel_id) person = await q1('SELECT * FROM personnel WHERE id=$1', [personnel_id]);
    else if (fingerprint_id) person = await q1('SELECT * FROM personnel WHERE fingerprint_id=$1', [fingerprint_id]);
    if (!person) return res.status(404).json({ error: 'Сотрудник не найден (проверьте отпечаток/ID)' });
    if (!person.active) return res.status(403).json({ error: 'Сотрудник отключён' });

    // Направление: явное или авто-переключение от последней отметки
    let dir = direction;
    if (dir !== 'in' && dir !== 'out') {
      const last = await q1('SELECT direction FROM attendance WHERE personnel_id=$1 ORDER BY at DESC LIMIT 1', [person.id]);
      dir = last && last.direction === 'in' ? 'out' : 'in';
    }
    const row = await q1(
      `INSERT INTO attendance (personnel_id, direction, source, device_id, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [person.id, dir, req.viaDevice ? 'device' : 'manual', device_id || null, req.user?.id || null]
    );
    res.json({ ok: true, personnel: { id: person.id, full_name: person.full_name }, direction: dir, at: row.at });
  })
);
