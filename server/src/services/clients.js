// Создание клиента — общая логика для онлайн-API (routes/clients.js) и
// офлайн-синхронизации (routes/sync.js), чтобы клиенты, заведённые без
// интернета, не терялись и попадали в базу при появлении связи.
import { q, q1, tx } from '../db.js';

// Следующий номер карты — только цифры (6 знаков), чтобы карту можно было
// продиктовать по телефону и набрать на любом сканере/клавиатуре.
export async function nextCardNo() {
  const row = await q1(`SELECT card_no FROM clients WHERE card_no ~ '^[0-9]+$' ORDER BY card_no::bigint DESC LIMIT 1`);
  const n = row ? Number(row.card_no) + 1 : 1;
  return String(n).padStart(6, '0');
}

// Реферальный код — тоже только цифры. Начинается с 9, чтобы никогда не
// совпасть с номером карты (карты нумеруются с 000001).
export function referralCodeFor(id) {
  return '9' + String(id).padStart(5, '0');
}

// Настройки реферальной программы «Приведи друга»
export async function getReferralSettings() {
  const rows = await q(
    `SELECT key, value FROM settings WHERE key IN ('referral_enabled','referral_referrer_bonus','referral_referee_bonus')`
  );
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    enabled: m.referral_enabled === true || m.referral_enabled === 'true',
    referrer: Number(m.referral_referrer_bonus || 0),
    referee: Number(m.referral_referee_bonus || 0),
  };
}

/**
 * Завести клиента. Возвращает созданную запись (с card_no и referral_code).
 * Идемпотентность офлайн-очереди обеспечивается на уровне sync_ops (client_uuid).
 */
export async function createClient({ full_name, phone, app_installed = false, note, kids = [], referrer_code }) {
  if (!full_name) {
    const err = new Error('Укажите имя клиента');
    err.status = 400;
    throw err;
  }
  const card_no = await nextCardNo();

  let referrer = null;
  if (referrer_code && referrer_code.trim()) {
    referrer = await q1('SELECT id FROM clients WHERE upper(referral_code) = upper($1)', [referrer_code.trim()]);
  }
  const ref = await getReferralSettings();

  return tx(async ({ q1: cq1, q: cq }) => {
    const c = await cq1(
      `INSERT INTO clients (full_name, phone, card_no, app_installed, note, referred_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [full_name, phone || null, card_no, app_installed, note || null, referrer ? referrer.id : null]
    );
    // личный реферальный код
    const code = referralCodeFor(c.id);
    await cq('UPDATE clients SET referral_code = $2 WHERE id = $1', [c.id, code]);
    c.referral_code = code;

    for (const k of kids) {
      if (k && k.name) {
        await cq('INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,$2,$3)', [
          c.id, k.name, k.birth_date || k.birth || null,
        ]);
      }
    }

    // Приглашённому — приветственный бонус сразу.
    // Пригласившему — НЕ сейчас: его бонус начислится, когда друг совершит покупку.
    if (referrer && ref.enabled && ref.referee > 0) {
      await cq('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
        c.id, ref.referee, 'Бонус за регистрацию по приглашению',
      ]);
      await cq('UPDATE clients SET bonus = bonus + $2 WHERE id=$1', [c.id, ref.referee]);
      c.bonus = Number(c.bonus) + ref.referee;
    }
    return { client: c, referrer };
  });
}
