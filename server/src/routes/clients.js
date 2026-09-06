import { Router } from 'express';
import { q, q1, tx } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';
import { createClient, phoneCanonical, findByPhoneDigits } from '../services/clients.js';

export const clientsRouter = Router();
clientsRouter.use(requireAuth, requirePerm('clients'));

// Гость говорит номер карты как придётся: «три», «000003», «№ 3», а телефон
// диктует то с +7, то с 8, со скобками и пробелами. Поэтому сравниваем не
// строки как есть, а только цифры: карту — без ведущих нулей, телефон —
// по вхождению цифр. Имя ищем по части слова.
const DIGITS = (col) => `regexp_replace(${col}, '[^0-9]', '', 'g')`;
// 8 916… и +7 916… — один и тот же номер: приводим к виду с 7 и сравниваем
// по последним 10 цифрам.
export function phoneTail(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length >= 10 ? d.slice(-10) : '';
}
function searchClause(raw, add) {
  const text = String(raw || '').trim();
  const digits = text.replace(/\D/g, '');
  const conds = [];
  // имя: от двух символов, иначе одна цифра «3» вытащит пол-базы
  if (text.length >= 2) conds.push(`c.full_name ILIKE ${add(`%${text}%`)}`);
  // старые карты с буквами
  if (/[a-zа-яё]/i.test(text)) conds.push(`c.card_no ILIKE ${add(`%${text}%`)}`);
  if (digits) {
    const exact = add(digits.replace(/^0+/, ''));
    conds.push(`ltrim(${DIGITS('c.card_no')}, '0') = ${exact}`); // карта: 3 = 000003
    conds.push(`c.referral_code = ${add(digits)}`); // код из приложения (9XXXXX)
  }
  const tail = phoneTail(text);
  if (tail) conds.push(`right(${DIGITS('c.phone')}, 10) = ${add(tail)}`);
  if (digits.length >= 3) {
    const part = add(`%${digits}%`);
    conds.push(`${DIGITS('c.phone')} LIKE ${part}`, `${DIGITS('c.card_no')} LIKE ${part}`);
  }
  return conds.length ? '(' + conds.join(' OR ') + ')' : 'true';
}

// GET /api/clients — поиск + фильтры
//   search   — по имени/телефону/карте
//   app      — 1|0 установлено ли приложение
//   min_bonus — минимум бонусов
//   min_buys  — минимум покупок
//   bday_days — у ребёнка ДР в ближайшие N дней
//   referral  — invited (кто-то пришёл по его коду) | referred (сам пришёл по коду)
clientsRouter.get(
  '/',
  ah(async (req, res) => {
    const { search, app, min_bonus, min_buys, bday_days, referral } = req.query;
    const where = [];
    const p = [];
    const add = (v) => { p.push(v); return '$' + p.length; };

    if (search && search.trim()) {
      where.push(searchClause(search, add));
    }
    if (app === '1' || app === '0') where.push(`c.app_installed = ${add(app === '1')}`);
    if (min_bonus) where.push(`c.bonus >= ${add(Number(min_bonus))}`);
    if (min_buys) where.push(`COALESCE(sc.buys,0) >= ${add(Number(min_buys))}`);
    if (bday_days) where.push(`bd.next_days <= ${add(Number(bday_days))}`);
    if (referral === 'invited') where.push(`EXISTS (SELECT 1 FROM clients r WHERE r.referred_by = c.id)`);
    if (referral === 'referred') where.push(`c.referred_by IS NOT NULL`);

    const rows = await q(
      `SELECT c.*,
              COALESCE(sc.buys,0)::int AS buys,
              sc.last_buy,
              bd.next_days AS kid_bday_in,
              COALESCE(kc.n,0)::int AS kids_count,
              COALESCE(pa.n,0)::int AS active_passes
         FROM clients c
         LEFT JOIN (SELECT client_id, count(*) AS buys, max(created_at) AS last_buy
                      FROM sales WHERE is_return=false AND client_id IS NOT NULL GROUP BY client_id) sc
                ON sc.client_id = c.id
         LEFT JOIN (SELECT client_id,
                           min(((date_part('doy',birth_date)::int - date_part('doy',current_date)::int + 366) % 366)) AS next_days
                      FROM client_kids WHERE birth_date IS NOT NULL GROUP BY client_id) bd
                ON bd.client_id = c.id
         LEFT JOIN (SELECT client_id, count(*) AS n FROM client_kids GROUP BY client_id) kc
                ON kc.client_id = c.id
         LEFT JOIN (SELECT client_id, count(*) AS n FROM passes
                     WHERE status='active' AND valid_to >= current_date GROUP BY client_id) pa
                ON pa.client_id = c.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      p
    );
    res.json(rows);
  })
);

// GET /api/clients/lookup?q= — быстрый поиск карты на кассе: по номеру карты,
// телефону или имени, по всей базе (а не по последним загруженным клиентам).
// Сверху точное совпадение карты, затем телефон, затем остальные — кассир
// видит нужного первым и не заводит дубль вручную.
clientsRouter.get(
  '/lookup',
  ah(async (req, res) => {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 1) return res.json([]);
    const p = [];
    const add = (v) => { p.push(v); return '$' + p.length; };
    const clause = searchClause(raw, add);
    const digits = raw.replace(/\D/g, '');
    const dg = add(digits.replace(/^0+/, ''));
    const tail = add(phoneTail(raw));
    const rows = await q(
      `SELECT c.id, c.full_name, c.phone, c.card_no, c.bonus,
              COALESCE(pa.n,0)::int AS active_passes
         FROM clients c
         LEFT JOIN (SELECT client_id, count(*) AS n FROM passes
                     WHERE status='active' AND valid_to >= current_date GROUP BY client_id) pa
                ON pa.client_id = c.id
        WHERE ${clause}
        ORDER BY CASE
                   WHEN ${dg} <> '' AND ltrim(${DIGITS('c.card_no')}, '0') = ${dg} THEN 0
                   WHEN ${tail} <> '' AND right(${DIGITS('c.phone')}, 10) = ${tail} THEN 1
                   ELSE 2
                 END, c.full_name
        LIMIT 10`,
      p
    );
    res.json(rows.map((r) => ({ ...r, bonus: Number(r.bonus) })));
  })
);

// GET /api/clients/duplicates — карты, заведённые на один и тот же телефон.
// Такие пары накопились, пока номер сравнивался как строка: «+7 916…» и
// «8916…» считались разными людьми. Группы отдаём, чтобы владелец объединил.
clientsRouter.get(
  '/duplicates',
  ah(async (req, res) => {
    const rows = await q(
      `WITH k AS (
         SELECT c.id, c.full_name, c.phone, c.card_no, c.bonus, c.app_installed, c.created_at,
                right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10) AS key
           FROM clients c
          WHERE c.phone IS NOT NULL AND c.phone <> ''
       ),
       dup AS (SELECT key FROM k WHERE key <> '' GROUP BY key HAVING count(*) > 1)
       SELECT k.*, COALESCE(s.buys, 0)::int AS buys
         FROM k JOIN dup ON dup.key = k.key
         LEFT JOIN (SELECT client_id, count(*) AS buys FROM sales
                     WHERE is_return = false AND client_id IS NOT NULL GROUP BY client_id) s
                ON s.client_id = k.id
        ORDER BY k.key, k.created_at`
    );
    const groups = [];
    const byKey = {};
    for (const r of rows) {
      if (!byKey[r.key]) { byKey[r.key] = { phone: r.phone, clients: [] }; groups.push(byKey[r.key]); }
      byKey[r.key].clients.push({
        id: r.id, full_name: r.full_name, phone: r.phone, card_no: r.card_no,
        bonus: Number(r.bonus), buys: r.buys, app_installed: r.app_installed, created_at: r.created_at,
      });
    }
    res.json(groups);
  })
);

// POST /api/clients/:id/merge { from_id } — объединить дубль в эту карту.
// Только владелец/администратор: операция переносит деньги (бонусы) и историю.
// Всё, что было у дубля — покупки, бонусные операции, абонементы, дети, брони
// и заявки — переезжает на выбранную карту, дубль удаляется.
clientsRouter.post(
  '/:id/merge',
  ah(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Объединять карты может только владелец или администратор' });
    }
    const keepId = String(req.params.id);
    const fromId = String((req.body || {}).from_id || '');
    if (!fromId) return res.status(400).json({ error: 'Укажите карту, которую объединяем' });
    if (fromId === keepId) return res.status(400).json({ error: 'Это одна и та же карта' });

    const keep = await q1('SELECT * FROM clients WHERE id=$1', [keepId]);
    const from = await q1('SELECT * FROM clients WHERE id=$1', [fromId]);
    if (!keep || !from) return res.status(404).json({ error: 'Клиент не найден' });

    const merged = await tx(async ({ q: cq, q1: cq1 }) => {
      for (const t of ['sales', 'loyalty_transactions', 'client_kids', 'passes', 'bookings', 'leads']) {
        await cq(`UPDATE ${t} SET client_id=$1 WHERE client_id=$2`, [keepId, fromId]);
      }
      await cq('UPDATE clients SET referred_by=$1 WHERE referred_by=$2', [keepId, fromId]);
      const row = await cq1(
        `UPDATE clients SET
           bonus = bonus + $2,
           app_installed = app_installed OR $3,
           pass_hash = COALESCE(pass_hash, $4),
           email = COALESCE(email, $5),
           phone = COALESCE(phone, $6),
           note = NULLIF(concat_ws(' · ', NULLIF(note,''), NULLIF($7,'')), '')
         WHERE id=$1 RETURNING *`,
        [keepId, Number(from.bonus) || 0, !!from.app_installed, from.pass_hash, from.email, from.phone, from.note]
      );
      // Бонусы дубля перенесены на эту карту — оставляем след в истории
      if (Number(from.bonus) > 0) {
        await cq('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
          keepId, 0, `Объединение карт: перенесено ${Number(from.bonus)} бонусов с карты ${from.card_no}`,
        ]);
      }
      await cq('DELETE FROM clients WHERE id=$1', [fromId]);
      return row;
    });
    await audit(req, 'client.merge', {
      entity: 'client', entityId: keep.id,
      meta: { from_id: from.id, from_card: from.card_no, from_bonus: Number(from.bonus) },
    });
    res.json(merged);
  })
);

// GET /api/clients/:id — карточка с детьми, историей покупок и бонусами
clientsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const client = await q1('SELECT * FROM clients WHERE id=$1', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    const [kids, loyalty, sales] = await Promise.all([
      q('SELECT * FROM client_kids WHERE client_id=$1 ORDER BY birth_date', [client.id]),
      q('SELECT * FROM loyalty_transactions WHERE client_id=$1 ORDER BY created_at DESC LIMIT 50', [client.id]),
      q(
        `SELECT s.id, s.total, s.method, s.bonus_earned, s.bonus_used, s.is_return, s.created_at,
                COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty,'price',i.price))
                         FILTER (WHERE i.id IS NOT NULL), '[]') AS items
           FROM sales s LEFT JOIN sale_items i ON i.sale_id = s.id
          WHERE s.client_id=$1
          GROUP BY s.id ORDER BY s.created_at DESC LIMIT 50`,
        [client.id]
      ),
    ]);
    const invited = await q1('SELECT count(*)::int AS c FROM clients WHERE referred_by=$1', [client.id]);
    const referrer = client.referred_by
      ? await q1('SELECT full_name FROM clients WHERE id=$1', [client.referred_by])
      : null;
    res.json({
      ...client,
      kids,
      loyalty,
      history: sales,
      invited_count: invited.c,
      referrer_name: referrer?.full_name || null,
    });
  })
);

// POST /api/clients
clientsRouter.post(
  '/',
  ah(async (req, res) => {
    let created;
    try {
      created = await createClient(req.body || {});
    } catch (e) {
      // Такой телефон уже в базе — возвращаем найденного клиента, чтобы касса
      // открыла его карту, а не завела вторую на того же человека
      if (e.status === 409 && e.existing) {
        return res.status(409).json({
          error: e.message,
          client: { id: e.existing.id, full_name: e.existing.full_name, phone: e.existing.phone,
                    card_no: e.existing.card_no, bonus: Number(e.existing.bonus) },
        });
      }
      throw e;
    }
    const { client, referrer } = created;
    await audit(req, 'client.create', { entity: 'client', entityId: client.id, meta: { referrer: referrer?.id } });
    res.json(client);
  })
);

// PUT /api/clients/:id
clientsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const { full_name, phone, app_installed, note, email } = req.body || {};
    if (full_name != null && !String(full_name).trim()) {
      return res.status(400).json({ error: 'Имя клиента не может быть пустым' });
    }
    // Один телефон — одна карта. Сравниваем по цифрам: «8916…» и «+7 916…» —
    // это один и тот же номер, хоть строки и разные.
    let phoneNorm = null;
    if (phone != null && String(phone).trim()) {
      phoneNorm = phoneCanonical(phone);
      const dup = await findByPhoneDigits(phoneNorm, req.params.id);
      if (dup) {
        return res.status(409).json({
          error: `Этот телефон уже записан за клиентом ${dup.full_name} (карта ${dup.card_no})`,
          client: { id: dup.id, full_name: dup.full_name, card_no: dup.card_no },
        });
      }
    }
    const row = await q1(
      `UPDATE clients SET
         full_name = COALESCE(NULLIF(trim($2),''), full_name),
         phone = COALESCE(NULLIF(trim($3),''), phone),
         app_installed = COALESCE($4, app_installed),
         note = COALESCE($5, note),
         email = COALESCE($6, email)
       WHERE id=$1 RETURNING *`,
      [req.params.id, full_name == null ? null : String(full_name), phoneNorm,
       app_installed, note, email == null ? null : String(email).trim()]
    );
    if (!row) return res.status(404).json({ error: 'Клиент не найден' });
    await audit(req, 'client.update', { entity: 'client', entityId: row.id });
    res.json(row);
  })
);

// DELETE /api/clients/:id — удалить клиента из базы (только владелец/администратор).
// История продаж сохраняется (продажи отвязываются от клиента), дети и бонусные
// операции удаляются вместе с клиентом.
clientsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    if (!['owner', 'admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Удалять клиентов может только владелец или администратор' });
    }
    const client = await q1('SELECT id, full_name FROM clients WHERE id=$1', [req.params.id]);
    if (!client) return res.status(404).json({ error: 'Клиент не найден' });
    await tx(async ({ q: cq }) => {
      await cq('UPDATE sales SET client_id=NULL WHERE client_id=$1', [client.id]);
      await cq('UPDATE leads SET client_id=NULL WHERE client_id=$1', [client.id]);
      await cq('UPDATE clients SET referred_by=NULL WHERE referred_by=$1', [client.id]);
      await cq('DELETE FROM clients WHERE id=$1', [client.id]); // дети и лояльность — каскадом
    });
    await audit(req, 'client.delete', { entity: 'client', entityId: client.id, meta: { name: client.full_name } });
    res.json({ ok: true });
  })
);

// POST /api/clients/:id/kids
clientsRouter.post(
  '/:id/kids',
  ah(async (req, res) => {
    const { name, birth_date } = req.body || {};
    const row = await q1('INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,$2,$3) RETURNING *', [
      req.params.id,
      name,
      birth_date || null,
    ]);
    res.json(row);
  })
);

// Удаление детей отключено: записи остаются в базе (история ДР, разовый
// бонус за добавление ребёнка не должен «переиспользоваться»).
clientsRouter.delete(
  '/:id/kids/:kidId',
  ah(async (req, res) => {
    res.status(403).json({ error: 'Удаление детей из базы отключено' });
  })
);

// POST /api/clients/:id/bonus — ручная корректировка бонусов
clientsRouter.post(
  '/:id/bonus',
  ah(async (req, res) => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Начислять и списывать бонусы вручную может только владелец' });
    }
    const { points, reason = 'Ручное начисление' } = req.body || {};
    const p = Math.round(Number(points));
    if (!p) return res.status(400).json({ error: 'Укажите количество баллов' });
    if (!String(reason || '').trim()) return res.status(400).json({ error: 'Напишите причину начисления' });
    if (p < 0) {
      const cur = await q1('SELECT bonus FROM clients WHERE id=$1', [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'Клиент не найден' });
      if (Number(cur.bonus) + p < 0) {
        return res.status(400).json({ error: 'У клиента только ' + cur.bonus + ' бонусов — списать больше нельзя' });
      }
    }
    const row = await tx(async ({ q1: cq1 }) => {
      await cq1('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
        req.params.id,
        p,
        String(reason).trim(),
      ]);
      return cq1('UPDATE clients SET bonus = bonus + $2 WHERE id=$1 RETURNING *', [req.params.id, p]);
    });
    await audit(req, 'client.bonus.adjust', { entity: 'client', entityId: req.params.id, meta: { points: p } });
    res.json(row);
  })
);

// GET /api/clients/birthdays/upcoming — дети с днём рождения в ближайшие N дней
clientsRouter.get(
  '/birthdays/upcoming',
  ah(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 14, 90);
    const rows = await q(
      `SELECT k.id, k.name AS kid_name, k.birth_date, c.id AS client_id, c.full_name, c.phone, c.app_installed,
              (date_part('doy', k.birth_date) )::int AS doy
         FROM client_kids k JOIN clients c ON c.id = k.client_id
        WHERE k.birth_date IS NOT NULL`,
      []
    );
    // Считаем ближайший ДР в JS (проще, чем в SQL с учётом перехода через год)
    const today = new Date();
    const withNext = rows
      .map((r) => {
        const b = new Date(r.birth_date);
        let next = new Date(today.getFullYear(), b.getMonth(), b.getDate());
        if (next < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
          next = new Date(today.getFullYear() + 1, b.getMonth(), b.getDate());
        }
        const inDays = Math.round((next - today) / 86400000);
        const turns = next.getFullYear() - b.getFullYear();
        return { ...r, in_days: inDays, turns_age: turns, next_date: next.toISOString().slice(0, 10) };
      })
      .filter((r) => r.in_days <= days)
      .sort((a, b) => a.in_days - b.in_days);
    res.json(withNext);
  })
);
