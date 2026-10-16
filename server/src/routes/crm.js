import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { nextCardNo, referralCodeFor, phoneCanonical, findByPhoneDigits } from '../services/clients.js';

export const crmRouter = Router();
crmRouter.use(requireAuth, requirePerm('crm'));

export const STAGES = ['new', 'contact', 'booking', 'won', 'lost'];
const STAGE_RU = { new: 'Новый', contact: 'Связались', booking: 'Бронь', won: 'Купил', lost: 'Отказ' };

// GET /api/crm/leads/new-count — сколько новых заявок (для бейджа-уведомления)
crmRouter.get(
  '/leads/new-count',
  ah(async (req, res) => {
    const r = await q1(`SELECT count(*) FILTER (WHERE status='new')::int AS c, COALESCE(max(id),0)::int AS last_id FROM leads`);
    res.json({ count: r.c, last_id: r.last_id });
  })
);

// GET /api/crm/leads — с задачами и примечаниями
// GET /api/crm/stats?from=YYYY-MM-DD&to=YYYY-MM-DD — картина воронки за период.
// «Поступило» — по дате создания, «взято в работу» — по first_touch_at,
// «куплено/отказ» — по closed_at. «В работе сейчас» и «зависшие» — на текущий
// момент, период на них не влияет.
crmRouter.get(
  '/stats',
  ah(async (req, res) => {
    const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
    const today = new Date();
    const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const to = day(req.query.to) || ymd(today);
    const from = day(req.query.from) || ymd(new Date(today.getTime() - 29 * 86400000));
    const P = [from, to];
    const inP = (col) => `${col} >= $1::date AND ${col} < ($2::date + 1)`;
    const [tot, bySrc, byUser, reasons, open, activity] = await Promise.all([
      q1(`SELECT
            (SELECT count(*) FROM leads WHERE ${inP('created_at')})::int AS created,
            (SELECT count(*) FROM leads WHERE ${inP('first_touch_at')})::int AS touched,
            (SELECT count(*) FROM leads WHERE status='won' AND ${inP('closed_at')})::int AS won,
            (SELECT COALESCE(sum(amount),0) FROM leads WHERE status='won' AND ${inP('closed_at')}) AS won_amount,
            (SELECT count(*) FROM leads WHERE status='lost' AND ${inP('closed_at')})::int AS lost,
            (SELECT count(*) FROM leads WHERE ${inP('created_at')} AND first_touch_at IS NOT NULL)::int AS created_touched,
            (SELECT count(*) FROM leads WHERE ${inP('created_at')} AND status='won')::int AS created_won,
            (SELECT avg(EXTRACT(EPOCH FROM (first_touch_at - created_at)))/3600 FROM leads WHERE ${inP('created_at')} AND first_touch_at IS NOT NULL) AS avg_reaction_h,
            (SELECT avg(EXTRACT(EPOCH FROM (closed_at - created_at)))/86400 FROM leads WHERE status='won' AND ${inP('closed_at')}) AS avg_to_won_d`, P),
      q(`SELECT COALESCE(NULLIF(trim(source),''),'не указан') AS source,
                count(*) FILTER (WHERE ${inP('created_at')})::int AS created,
                count(*) FILTER (WHERE status='won' AND ${inP('closed_at')})::int AS won,
                count(*) FILTER (WHERE status='lost' AND ${inP('closed_at')})::int AS lost
           FROM leads
          WHERE ${inP('created_at')} OR (status IN ('won','lost') AND ${inP('closed_at')})
          GROUP BY 1 ORDER BY created DESC, won DESC`, P),
      q(`SELECT u.id, u.full_name AS name, u.role_code AS role,
                count(*) FILTER (WHERE ${inP('l.first_touch_at')})::int AS taken,
                count(*) FILTER (WHERE l.status='won' AND ${inP('l.closed_at')})::int AS won,
                COALESCE(sum(l.amount) FILTER (WHERE l.status='won' AND ${inP('l.closed_at')}),0) AS won_amount,
                count(*) FILTER (WHERE l.status='lost' AND ${inP('l.closed_at')})::int AS lost,
                count(*) FILTER (WHERE l.status IN ('new','contact','booking'))::int AS open,
                (SELECT count(*) FROM lead_events e WHERE e.user_id=u.id AND ${inP('e.created_at')})::int AS moves
           FROM users u JOIN leads l ON l.owner_id=u.id
          GROUP BY u.id, u.full_name, u.role_code
         HAVING count(*) FILTER (WHERE ${inP('l.first_touch_at')} OR (l.status IN ('won','lost') AND ${inP('l.closed_at')}) OR l.status IN ('new','contact','booking')) > 0
          ORDER BY won DESC, taken DESC, u.full_name`, P),
      q(`SELECT COALESCE(NULLIF(trim(lost_reason),''),'причина не указана') AS reason, count(*)::int AS n
           FROM leads WHERE status='lost' AND ${inP('closed_at')} GROUP BY 1 ORDER BY n DESC LIMIT 8`, P),
      q1(`SELECT count(*) FILTER (WHERE status='new')::int AS new,
                 count(*) FILTER (WHERE status='contact')::int AS contact,
                 count(*) FILTER (WHERE status='booking')::int AS booking,
                 count(*) FILTER (WHERE status='new' AND created_at < now() - interval '24 hours')::int AS stale_new,
                 count(*) FILTER (WHERE status IN ('contact','booking') AND updated_at < now() - interval '3 days')::int AS stale_open,
                 count(*) FILTER (WHERE status IN ('new','contact','booking') AND owner_id IS NULL)::int AS unassigned
            FROM leads`),
      q(`SELECT to_char(created_at::date,'YYYY-MM-DD') AS day, count(*)::int AS n FROM leads WHERE ${inP('created_at')} GROUP BY 1 ORDER BY 1`, P),
    ]);
    const closed = tot.won + tot.lost;
    res.json({
      from, to,
      created: tot.created, touched: tot.touched, won: tot.won, lost: tot.lost,
      won_amount: Number(tot.won_amount || 0),
      processed_pct: tot.created ? Math.round((tot.created_touched / tot.created) * 100) : 0,
      conversion_closed_pct: closed ? Math.round((tot.won / closed) * 100) : 0,
      conversion_created_pct: tot.created ? Math.round((tot.created_won / tot.created) * 100) : 0,
      avg_reaction_h: tot.avg_reaction_h == null ? null : Math.round(Number(tot.avg_reaction_h) * 10) / 10,
      avg_to_won_d: tot.avg_to_won_d == null ? null : Math.round(Number(tot.avg_to_won_d) * 10) / 10,
      open: { new: open.new, contact: open.contact, booking: open.booking, total: open.new + open.contact + open.booking,
              stale_new: open.stale_new, stale_open: open.stale_open, unassigned: open.unassigned },
      by_source: bySrc, by_user: byUser.map((u) => ({ ...u, won_amount: Number(u.won_amount || 0) })),
      lost_reasons: reasons, by_day: activity,
    });
  })
);

crmRouter.get(
  '/leads',
  ah(async (req, res) => {
    const leads = await q(
      `SELECT l.*, u.full_name AS owner_name
         FROM leads l LEFT JOIN users u ON u.id = l.owner_id
        ORDER BY l.updated_at DESC`
    );
    const tasks = await q('SELECT * FROM lead_tasks ORDER BY due_date NULLS LAST, id');
    const notes = await q('SELECT * FROM lead_notes ORDER BY created_at DESC');
    const byTask = {};
    for (const t of tasks) (byTask[t.lead_id] ||= []).push(t);
    const byNote = {};
    for (const n of notes) (byNote[n.lead_id] ||= []).push(n);
    res.json(leads.map((l) => ({ ...l, tasks: byTask[l.id] || [], notes: byNote[l.id] || [] })));
  })
);

// Примечания к лиду/заказу
crmRouter.get(
  '/leads/:id/notes',
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM lead_notes WHERE lead_id=$1 ORDER BY created_at DESC', [req.params.id]));
  })
);
crmRouter.post(
  '/leads/:id/notes',
  ah(async (req, res) => {
    const { text } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'Пустое примечание' });
    const row = await q1('INSERT INTO lead_notes (lead_id, text, author) VALUES ($1,$2,$3) RETURNING *', [
      req.params.id,
      text.trim(),
      req.user.name || null,
    ]);
    res.json(row);
  })
);

crmRouter.post(
  '/leads',
  ah(async (req, res) => {
    const { name, phone, source, status = 'new', amount = 0, note } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Укажите имя' });
    const row = await q1(
      `INSERT INTO leads (name, phone, source, status, amount, note, first_touch_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4<>'new' THEN now() END, CASE WHEN $4 IN ('won','lost') THEN now() END) RETURNING *`,
      [name, phone || null, source || null, status, amount, note || null]
    );
    if (status !== 'new') await q(`INSERT INTO lead_events (lead_id, from_status, to_status, user_id) VALUES ($1,NULL,$2,$3)`, [row.id, status, req.user.id]);
    await audit(req, 'lead.create', { entity: 'lead', entityId: row.id });
    res.json({ ...row, tasks: [] });
  })
);

// POST /api/crm/leads/from-client { client_id, source, note, amount }
// Постоянного гостя тоже нужно вести по воронке: позвонить про праздник,
// предложить абонемент. Имя и телефон берём из карточки клиента, а не из
// того, что прислал браузер, и сразу связываем заявку с картой.
crmRouter.post(
  '/leads/from-client',
  ah(async (req, res) => {
    const { client_id, source, note, amount = 0 } = req.body || {};
    if (!client_id) return res.status(400).json({ error: 'Укажите клиента' });
    const c = await q1('SELECT id, full_name, phone, card_no FROM clients WHERE id=$1', [client_id]);
    if (!c) return res.status(404).json({ error: 'Клиент не найден' });

    // Одна открытая заявка на клиента: вторая такая же только путает воронку
    const open = await q1(
      `SELECT * FROM leads WHERE client_id=$1 AND status NOT IN ('won','lost') ORDER BY id DESC LIMIT 1`,
      [c.id]
    );
    if (open) {
      return res.status(409).json({
        error: `По клиенту ${c.full_name} уже есть заявка в воронке (этап «${STAGE_RU[open.status] || open.status}»)`,
        lead: open,
      });
    }

    const row = await q1(
      `INSERT INTO leads (name, phone, source, status, amount, note, client_id)
       VALUES ($1,$2,$3,'new',$4,$5,$6) RETURNING *`,
      [c.full_name, c.phone, String(source || '').trim() || 'Из базы клиентов', amount,
       String(note || '').trim() || null, c.id]
    );
    await audit(req, 'lead.from_client', { entity: 'lead', entityId: row.id, meta: { client_id: c.id, card_no: c.card_no } });
    res.json({ ...row, tasks: [], notes: [] });
  })
);

crmRouter.put(
  '/leads/:id',
  ah(async (req, res) => {
    const { name, phone, source, status, amount, note, lost_reason } = req.body || {};
    const cur = await q1('SELECT id, status FROM leads WHERE id=$1', [req.params.id]);
    if (!cur) return res.status(404).json({ error: 'Лид не найден' });
    const next = status && STAGES.includes(status) ? status : cur.status;
    const changed = next !== cur.status;
    const reason = lost_reason != null ? String(lost_reason).trim().slice(0, 300) || null : null;
    const row = await q1(
      `UPDATE leads SET
         name=COALESCE($2,name), phone=COALESCE($3,phone), source=COALESCE($4,source),
         status=$5, amount=COALESCE($6,amount), note=COALESCE($7,note),
         -- взяли в работу: первый уход из «Новый»
         first_touch_at = CASE WHEN $5<>'new' THEN COALESCE(first_touch_at, now()) ELSE first_touch_at END,
         -- закрыли / вернули в работу
         closed_at = CASE WHEN $5 IN ('won','lost') THEN COALESCE(CASE WHEN $8::bool THEN NULL ELSE closed_at END, now()) ELSE NULL END,
         lost_reason = CASE WHEN $5='lost' THEN COALESCE($9, lost_reason) ELSE NULL END,
         updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, phone, source, next, amount, note, changed, reason]
    );
    if (changed) {
      await q(`INSERT INTO lead_events (lead_id, from_status, to_status, user_id, reason) VALUES ($1,$2,$3,$4,$5)`,
        [row.id, cur.status, next, req.user.id, next === 'lost' ? row.lost_reason : null]);
    }
    res.json(row);
  })
);

// POST /api/crm/leads/:id/owner { owner_id } — кто взял заявку в работу.
// Пустой owner_id снимает ответственного. Сотрудника берём из базы, а не из
// присланного имени, чтобы в воронке не появлялись «Оля» и «Ольга».
crmRouter.post(
  '/leads/:id/owner',
  ah(async (req, res) => {
    const raw = (req.body || {}).owner_id;
    const ownerId = raw === '' || raw == null ? null : Number(raw);
    let owner = null;
    if (ownerId) {
      owner = await q1('SELECT id, full_name, is_active FROM users WHERE id=$1', [ownerId]);
      if (!owner) return res.status(404).json({ error: 'Сотрудник не найден' });
      if (!owner.is_active) return res.status(400).json({ error: 'Сотрудник отключён — выберите работающего' });
    }
    const row = await q1(
      `UPDATE leads SET owner_id=$2, first_touch_at = CASE WHEN $2::bigint IS NOT NULL THEN COALESCE(first_touch_at, now()) ELSE first_touch_at END, updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, ownerId]
    );
    if (!row) return res.status(404).json({ error: 'Заявка не найдена' });
    await audit(req, 'lead.owner', { entity: 'lead', entityId: row.id, meta: { owner_id: ownerId } });
    res.json({ ...row, owner_name: owner ? owner.full_name : null });
  })
);

crmRouter.delete(
  '/leads/:id',
  ah(async (req, res) => {
    await q('DELETE FROM leads WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);

// Задачи по лиду
crmRouter.post(
  '/leads/:id/tasks',
  ah(async (req, res) => {
    const { title, due_date } = req.body || {};
    const row = await q1('INSERT INTO lead_tasks (lead_id, title, due_date) VALUES ($1,$2,$3) RETURNING *', [
      req.params.id,
      title,
      due_date || null,
    ]);
    res.json(row);
  })
);

crmRouter.put(
  '/tasks/:taskId',
  ah(async (req, res) => {
    const { done, title, due_date } = req.body || {};
    const row = await q1(
      `UPDATE lead_tasks SET done=COALESCE($2,done), title=COALESCE($3,title), due_date=COALESCE($4,due_date)
       WHERE id=$1 RETURNING *`,
      [req.params.taskId, done, title, due_date]
    );
    res.json(row);
  })
);

// POST /api/crm/leads/:id/convert — перенос лида в клиентскую базу
crmRouter.post(
  '/leads/:id/convert',
  ah(async (req, res) => {
    const lead = await q1('SELECT * FROM leads WHERE id=$1', [req.params.id]);
    if (!lead) return res.status(404).json({ error: 'Лид не найден' });
    if (lead.client_id) return res.status(409).json({ error: 'Лид уже в базе клиентов' });

    // Тот же телефон может быть уже заведён — тогда не создаём вторую карту,
    // а привязываем заявку к существующей (бонусы и история остаются на ней).
    const existing = await findByPhoneDigits(lead.phone);
    if (existing) {
      await q('UPDATE leads SET client_id=$2, updated_at=now() WHERE id=$1', [lead.id, existing.id]);
      await audit(req, 'lead.convert', {
        entity: 'lead', entityId: lead.id, meta: { client_id: existing.id, existing: true },
      });
      return res.json({ ...existing, existing: true });
    }
    const card_no = await nextCardNo();
    const client = await tx(async ({ q1: cq1 }) => {
      const c = await cq1(
        'INSERT INTO clients (full_name, phone, card_no, note) VALUES ($1,$2,$3,$4) RETURNING *',
        [lead.name, phoneCanonical(lead.phone), card_no, lead.note]
      );
      // Реферальный код нужен и клиенту из воронки — иначе он не сможет звать друзей
      c.referral_code = referralCodeFor(c.id);
      await cq1('UPDATE clients SET referral_code=$2 WHERE id=$1 RETURNING id', [c.id, c.referral_code]);
      // Статус НЕ меняем: заявка остаётся на своём этапе воронки,
      // просто получает связь с созданным клиентом (метка «уже клиент»).
      await cq1('UPDATE leads SET client_id=$2, updated_at=now() WHERE id=$1', [lead.id, c.id]);
      return c;
    });
    await audit(req, 'lead.convert', { entity: 'lead', entityId: lead.id, meta: { client_id: client.id } });
    res.json(client);
  })
);
