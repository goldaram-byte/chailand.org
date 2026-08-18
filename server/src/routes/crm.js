import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const crmRouter = Router();
crmRouter.use(requireAuth, requirePerm('crm'));

export const STAGES = ['new', 'contact', 'booking', 'won', 'lost'];

// GET /api/crm/leads/new-count — сколько новых заявок (для бейджа-уведомления)
crmRouter.get(
  '/leads/new-count',
  ah(async (req, res) => {
    const r = await q1(`SELECT count(*) FILTER (WHERE status='new')::int AS c, COALESCE(max(id),0)::int AS last_id FROM leads`);
    res.json({ count: r.c, last_id: r.last_id });
  })
);

// GET /api/crm/leads — с задачами и примечаниями
crmRouter.get(
  '/leads',
  ah(async (req, res) => {
    const leads = await q('SELECT * FROM leads ORDER BY updated_at DESC');
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
      'INSERT INTO leads (name, phone, source, status, amount, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, phone || null, source || null, status, amount, note || null]
    );
    await audit(req, 'lead.create', { entity: 'lead', entityId: row.id });
    res.json({ ...row, tasks: [] });
  })
);

crmRouter.put(
  '/leads/:id',
  ah(async (req, res) => {
    const { name, phone, source, status, amount, note } = req.body || {};
    const row = await q1(
      `UPDATE leads SET
         name=COALESCE($2,name), phone=COALESCE($3,phone), source=COALESCE($4,source),
         status=COALESCE($5,status), amount=COALESCE($6,amount), note=COALESCE($7,note),
         updated_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, phone, source, status, amount, note]
    );
    res.json(row);
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
    // Номер карты
    const cardRow = await q1(`SELECT card_no FROM clients WHERE card_no ~ '^GAB-[0-9]+$' ORDER BY card_no DESC LIMIT 1`);
    const n = cardRow ? parseInt(cardRow.card_no.slice(4), 10) + 1 : 1;
    const card_no = 'GAB-' + String(n).padStart(4, '0');
    const client = await tx(async ({ q1: cq1 }) => {
      const c = await cq1(
        'INSERT INTO clients (full_name, phone, card_no, note) VALUES ($1,$2,$3,$4) RETURNING *',
        [lead.name, lead.phone, card_no, lead.note]
      );
      await cq1('UPDATE leads SET client_id=$2, status=$3, updated_at=now() WHERE id=$1', [lead.id, c.id, 'won']);
      return c;
    });
    await audit(req, 'lead.convert', { entity: 'lead', entityId: lead.id, meta: { client_id: client.id } });
    res.json(client);
  })
);
