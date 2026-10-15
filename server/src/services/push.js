// Web Push для личного кабинета (PWA). Подписки устройств лежат в
// push_subscriptions; VAPID-ключи создаются один раз при первом обращении
// и хранятся в settings (ключ vapid_keys), чтобы не настраивать .env.
// Переопределить можно переменными VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.
import webpush from 'web-push';
import { q, q1 } from '../db.js';

let vapid = null;

export async function getVapid() {
  if (vapid) return vapid;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = await q1(`SELECT value FROM settings WHERE key='vapid_keys'`);
    if (row && row.value && row.value.publicKey && row.value.privateKey) {
      vapid = row.value;
    } else {
      vapid = webpush.generateVAPIDKeys();
      await q(
        `INSERT INTO settings (key, value) VALUES ('vapid_keys', $1::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify(vapid)]
      );
      // если ключи успел записать другой процесс — берём его вариант
      const again = await q1(`SELECT value FROM settings WHERE key='vapid_keys'`);
      if (again && again.value && again.value.publicKey) vapid = again.value;
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@chailand.org', vapid.publicKey, vapid.privateKey);
  return vapid;
}

export function validSubscription(s) {
  return !!(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000 &&
    s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');
}

export async function saveSubscription(clientId, sub, userAgent) {
  await q(
    `INSERT INTO push_subscriptions (client_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET client_id=EXCLUDED.client_id, p256dh=EXCLUDED.p256dh,
       auth=EXCLUDED.auth, user_agent=EXCLUDED.user_agent, last_seen_at=now()`,
    [clientId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent ? String(userAgent).slice(0, 300) : null]
  );
}

export async function removeSubscription(clientId, endpoint) {
  await q(`DELETE FROM push_subscriptions WHERE endpoint=$1 AND ($2::bigint IS NULL OR client_id=$2)`, [endpoint, clientId]);
}

// Отправить одно уведомление на одну подписку. Возвращает 'sent' | 'gone' | 'error'.
async function sendOne(row, payload) {
  const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 24, timeout: 10000 });
    await q(`UPDATE push_subscriptions SET last_sent_at=now() WHERE id=$1`, [row.id]);
    return 'sent';
  } catch (e) {
    // 404/410 — подписка умерла (пользователь отключил уведомления, переустановил приложение)
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      await q(`DELETE FROM push_subscriptions WHERE id=$1`, [row.id]);
      return 'gone';
    }
    console.error('[push]', row.id, e && (e.statusCode || e.message));
    return 'error';
  }
}

async function sendRows(rows, payload, concurrency = 10) {
  await getVapid();
  const out = { total: rows.length, sent: 0, gone: 0, error: 0 };
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (i < rows.length) {
        const r = rows[i++];
        out[await sendOne(r, payload)]++;
      }
    })
  );
  return out;
}

export function makePayload({ title, body, url, tag }) {
  return {
    title: String(title || 'ЧайЛэнд').slice(0, 120),
    body: String(body || '').slice(0, 500),
    url: url ? String(url).slice(0, 300) : '/lk/',
    tag: tag ? String(tag).slice(0, 60) : undefined,
    icon: '/logo.png',
  };
}

export async function sendToClient(clientId, payload) {
  const rows = await q(`SELECT * FROM push_subscriptions WHERE client_id=$1`, [clientId]);
  return sendRows(rows, payload);
}

export async function sendToAll(payload) {
  const rows = await q(`SELECT * FROM push_subscriptions ORDER BY id`);
  return sendRows(rows, payload);
}

export async function countSubscriptions(clientId) {
  const r = await q1(
    clientId ? `SELECT count(*)::int AS n FROM push_subscriptions WHERE client_id=$1` : `SELECT count(*)::int AS n FROM push_subscriptions`,
    clientId ? [clientId] : []
  );
  return r ? r.n : 0;
}
