// Клиентское приложение «личный кабинет» (PWA).
// Вход/регистрация — по номеру телефона и собственному паролю клиента.
// Здесь клиент видит карту с QR, баланс бонусов, историю, приглашает друзей,
// оставляет заявку на праздник (падает в воронку) и правит профиль/детей.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import QRCode from 'qrcode';
import { q, q1, tx } from '../db.js';
import { ah } from '../util.js';
import { hashPassword, checkPassword, signClientToken, requireClient } from '../auth.js';
import { createClient } from '../services/clients.js';

export const clientAppRouter = Router();

// Всё, что клиент вводит сам (имя, почта, имена детей), показывается в
// админке — HTML-теги срезаем, чтобы из приложения нельзя было занести
// скрипт в панель сотрудника (stored XSS).
const noTags = (v) => (v == null ? null : String(v).replace(/[<>]/g, '').trim());

// --- Телефон: приводим к каноничному виду и к «только цифры» для поиска ---
function phoneDigits(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d; // без кода страны — считаем РФ
  return d;
}
function phoneCanonical(s) {
  const d = phoneDigits(s);
  return d ? '+' + d : '';
}
function validPhone(d) {
  return /^7\d{10}$/.test(d) || /^\d{10,15}$/.test(d);
}

// Найти клиента по номеру (сравниваем только цифры)
async function findByPhone(phone) {
  const d = phoneDigits(phone);
  if (!d) return null;
  return q1(`SELECT * FROM clients WHERE regexp_replace(phone,'\\D','','g') = $1 LIMIT 1`, [d]);
}

// Публичная витрина профиля для приложения
function publicClient(c) {
  return {
    id: c.id,
    full_name: c.full_name,
    phone: c.phone,
    email: c.email || null,
    card_no: c.card_no,
    bonus: Number(c.bonus || 0),
    referral_code: c.referral_code,
    app_installed: c.app_installed,
  };
}

// Анти-подбор: не больше 20 попыток входа/регистрации с IP за 10 минут
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
});

// ---------------------------------------------------------------------------
// Регистрация: телефон + пароль (+ имя). Если номер уже заведён кассиром
// (карта, бонусы) — «привязываем» к нему пароль, история сохраняется.
// ---------------------------------------------------------------------------
clientAppRouter.post(
  '/auth/register',
  authLimiter,
  ah(async (req, res) => {
    const b = req.body || {};
    const digits = phoneDigits(b.phone);
    const password = String(b.password || '');
    const full_name = noTags(b.full_name) || '';
    const referrer_code = String(b.referrer_code || '').trim();

    if (!validPhone(digits)) return res.status(400).json({ error: 'Укажите корректный номер телефона' });
    if (password.length < 4) return res.status(400).json({ error: 'Пароль — минимум 4 символа' });
    if (!full_name) return res.status(400).json({ error: 'Как вас зовут?' });

    const existing = await findByPhone(digits);
    if (existing && existing.pass_hash) {
      return res.status(409).json({ error: 'Этот номер уже зарегистрирован. Войдите по паролю.' });
    }

    let client;
    if (existing) {
      // Клиент уже есть (завёл кассир) — задаём пароль и включаем приложение.
      client = await q1(
        `UPDATE clients SET pass_hash=$2, app_installed=true,
           full_name = CASE WHEN $3 <> '' THEN $3 ELSE full_name END
         WHERE id=$1 RETURNING *`,
        [existing.id, hashPassword(password), full_name]
      );
    } else {
      const { client: c } = await createClient({
        full_name,
        phone: phoneCanonical(digits),
        app_installed: true,
        referrer_code: referrer_code || undefined,
      });
      client = await q1('UPDATE clients SET pass_hash=$2 WHERE id=$1 RETURNING *', [c.id, hashPassword(password)]);
    }

    res.json({ token: signClientToken(client), client: publicClient(client) });
  })
);

// ---------------------------------------------------------------------------
// Вход: телефон + пароль
// ---------------------------------------------------------------------------
clientAppRouter.post(
  '/auth/login',
  authLimiter,
  ah(async (req, res) => {
    const b = req.body || {};
    const client = await findByPhone(b.phone);
    const password = String(b.password || '');
    if (!client || !client.pass_hash || !checkPassword(password, client.pass_hash)) {
      return res.status(401).json({ error: 'Неверный телефон или пароль' });
    }
    res.json({ token: signClientToken(client), client: publicClient(client) });
  })
);

// Дальше — только с токеном клиента
clientAppRouter.use(requireClient);

// Профиль + сводка (бонусы, дети, приглашённые, кто пригласил)
clientAppRouter.get(
  '/me',
  ah(async (req, res) => {
    const c = await q1('SELECT * FROM clients WHERE id=$1', [req.client.id]);
    if (!c) return res.status(404).json({ error: 'Профиль не найден' });
    const kids = await q('SELECT id, name, birth_date FROM client_kids WHERE client_id=$1 ORDER BY birth_date NULLS LAST, id', [c.id]);
    const inv = await q1('SELECT count(*)::int AS n FROM clients WHERE referred_by=$1', [c.id]);
    let referrer = null;
    if (c.referred_by) {
      const r = await q1('SELECT full_name FROM clients WHERE id=$1', [c.referred_by]);
      referrer = r ? r.full_name : null;
    }
    res.json({ ...publicClient(c), kids, invited_count: inv.n, referrer_name: referrer, note: c.note || null });
  })
);

clientAppRouter.put(
  '/me',
  ah(async (req, res) => {
    const full_name = noTags((req.body || {}).full_name);
    const email = noTags((req.body || {}).email);
    const c = await q1(
      `UPDATE clients SET
         full_name = COALESCE(NULLIF(trim($2),''), full_name),
         email     = COALESCE($3, email)
       WHERE id=$1 RETURNING *`,
      [req.client.id, full_name, email]
    );
    res.json(publicClient(c));
  })
);

// Смена пароля
clientAppRouter.post(
  '/me/password',
  ah(async (req, res) => {
    const { old_password, new_password } = req.body || {};
    const c = await q1('SELECT pass_hash FROM clients WHERE id=$1', [req.client.id]);
    if (!c || !c.pass_hash || !checkPassword(String(old_password || ''), c.pass_hash)) {
      return res.status(400).json({ error: 'Текущий пароль неверный' });
    }
    if (String(new_password || '').length < 4) return res.status(400).json({ error: 'Новый пароль — минимум 4 символа' });
    await q('UPDATE clients SET pass_hash=$2 WHERE id=$1', [req.client.id, hashPassword(String(new_password))]);
    res.json({ ok: true });
  })
);

// История бонусов (начисления/списания)
clientAppRouter.get(
  '/history',
  ah(async (req, res) => {
    const rows = await q(
      `SELECT id, points, reason, created_at FROM loyalty_transactions
        WHERE client_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [req.client.id]
    );
    res.json(rows);
  })
);

// Дети (для напоминаний о ДР)
clientAppRouter.get(
  '/kids',
  ah(async (req, res) => {
    res.json(await q('SELECT id, name, birth_date FROM client_kids WHERE client_id=$1 ORDER BY birth_date NULLS LAST, id', [req.client.id]));
  })
);
// За первого добавленного ребёнка клиент получает разовый бонус.
// Отметка kid_bonus_at на карте клиента: начисляется строго один раз,
// удаление и повторное добавление детей ничего не даёт.
const KID_ADD_BONUS = 100;
clientAppRouter.post(
  '/kids',
  ah(async (req, res) => {
    const { name, birth_date } = req.body || {};
    const kidName = noTags(name);
    if (!kidName) return res.status(400).json({ error: 'Укажите имя ребёнка' });
    const result = await tx(async ({ q: cq, q1: cq1 }) => {
      const row = await cq1(
        'INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,$2,$3) RETURNING id, name, birth_date',
        [req.client.id, kidName, birth_date || null]
      );
      // WHERE kid_bonus_at IS NULL делает начисление атомарно-однократным
      const awarded = await cq1(
        'UPDATE clients SET bonus = bonus + $2, kid_bonus_at = now() WHERE id=$1 AND kid_bonus_at IS NULL RETURNING id',
        [req.client.id, KID_ADD_BONUS]
      );
      if (awarded) {
        await cq('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
          req.client.id, KID_ADD_BONUS, 'Бонус за добавление ребёнка в приложении',
        ]);
      }
      return { ...row, bonus_awarded: awarded ? KID_ADD_BONUS : 0 };
    });
    res.json(result);
  })
);
clientAppRouter.put(
  '/kids/:id',
  ah(async (req, res) => {
    const { birth_date } = req.body || {};
    const name = noTags((req.body || {}).name);
    const row = await q1(
      `UPDATE client_kids SET name=COALESCE(NULLIF(trim($3),''),name), birth_date=COALESCE($4,birth_date)
        WHERE id=$1 AND client_id=$2 RETURNING id, name, birth_date`,
      [req.params.id, req.client.id, name == null ? null : String(name), birth_date || null]
    );
    if (!row) return res.status(404).json({ error: 'Не найдено' });
    res.json(row);
  })
);
// Удаление детей отключено: записи о детях остаются в базе (история ДР,
// разовый бонус). Ошибку в имени или дате клиент исправляет через PUT.
clientAppRouter.delete(
  '/kids/:id',
  ah(async (req, res) => {
    res.status(403).json({ error: 'Удаление недоступно. Имя и дату рождения можно исправить, остальное — на кассе парка.' });
  })
);

// «Приведи друга» — код, статистика приглашений и начисленные за них бонусы
clientAppRouter.get(
  '/referrals',
  ah(async (req, res) => {
    const c = await q1('SELECT referral_code FROM clients WHERE id=$1', [req.client.id]);
    const inv = await q1('SELECT count(*)::int AS n FROM clients WHERE referred_by=$1', [req.client.id]);
    const earned = await q1(
      `SELECT COALESCE(sum(points),0)::int AS s FROM loyalty_transactions
        WHERE client_id=$1 AND reason ILIKE '%приглашённого друга%'`,
      [req.client.id]
    );
    const friends = await q(
      `SELECT full_name, created_at, referral_rewarded FROM clients WHERE referred_by=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.client.id]
    );
    // Условия программы — для показа в приложении
    const st = {};
    for (const r of await q(`SELECT key, value FROM settings WHERE key IN ('referral_enabled','referral_referrer_percent','referral_referee_bonus')`)) {
      st[r.key] = r.value;
    }
    res.json({
      code: c ? c.referral_code : null,
      invited_count: inv.n,
      earned_bonus: earned.s,
      friends,
      enabled: st.referral_enabled === true || st.referral_enabled === 'true',
      referrer_percent: Number(st.referral_referrer_percent || 0),
      referee_bonus: Number(st.referral_referee_bonus || 0),
    });
  })
);

// Заявка на праздник → прямо в воронку (статус new). Кассир получит звук.
clientAppRouter.post(
  '/leads',
  ah(async (req, res) => {
    const c = await q1('SELECT full_name, phone FROM clients WHERE id=$1', [req.client.id]);
    const b = req.body || {};
    const parts = [];
    if (b.event_date) parts.push('Дата: ' + String(b.event_date).slice(0, 20));
    if (b.kids_count) parts.push('Детей: ' + String(b.kids_count).slice(0, 10));
    if (b.note) parts.push(String(b.note).slice(0, 1000));
    const note = parts.join('. ') || 'Заявка из приложения';
    const lead = await q1(
      `INSERT INTO leads (name, phone, source, status, note, client_id)
       VALUES ($1,$2,'Приложение','new',$3,$4) RETURNING id`,
      [c.full_name, c.phone, note, req.client.id]
    );
    res.json({ ok: true, id: lead.id });
  })
);

// QR карты лояльности (SVG) — кассир сканирует номер карты клиента
// Абонементы клиента: сколько посещений осталось и до какого числа действует
clientAppRouter.get(
  '/passes',
  ah(async (req, res) => {
    // Лениво помечаем истёкшие, чтобы клиент видел актуальный статус
    await q(`UPDATE passes SET status='expired' WHERE client_id=$1 AND status='active' AND valid_to < current_date`, [req.client.id]);
    const rows = await q(
      `SELECT p.id, p.name, p.kid_name, p.status, p.visits_total, p.visits_left, p.valid_from, p.valid_to,
              -- Где абонемент действует сейчас (а не где его купили): список
              -- берём из настройки вида, чтобы клиент видел актуальные парки.
              (SELECT string_agg(lo.name, ', ' ORDER BY lo.sort, lo.id)
                 FROM locations lo
                WHERE lo.id = ANY(COALESCE(t.location_ids, p.location_ids))) AS works_in,
              (SELECT count(*)::int FROM pass_visits v WHERE v.pass_id = p.id) AS visits_used,
              (SELECT max(v.at) FROM pass_visits v WHERE v.pass_id = p.id) AS last_visit_at
         FROM passes p
         LEFT JOIN pass_types t ON t.id = p.pass_type_id
        WHERE p.client_id=$1
        ORDER BY (p.status='active') DESC, p.valid_to DESC, p.id DESC
        LIMIT 20`,
      [req.client.id]
    );
    res.json(rows);
  })
);

clientAppRouter.get(
  '/card-qr',
  ah(async (req, res) => {
    const c = await q1('SELECT card_no, referral_code FROM clients WHERE id=$1', [req.client.id]);
    const payload = c && c.card_no ? c.card_no : c && c.referral_code ? c.referral_code : String(req.client.id);
    const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, width: 260, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  })
);
