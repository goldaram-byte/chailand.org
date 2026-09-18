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
      'INSERT INTO leads (name, phone, source, status, amount, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [name, phone || null, source || null, status, amount, note || null]
    );
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
      'UPDATE leads SET owner_id=$2, updated_at=now() WHERE id=$1 RETURNING *',
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
