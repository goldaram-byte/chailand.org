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

// Телефон храним в одном виде: +7XXXXXXXXXX. Иначе один и тот же гость
// заводится дважды: «+7 916 111-22-33», «89161112233» и «+79161112233» —
// три разные строки, но один человек и три карты с разными бонусами.
export function phoneCanonical(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (d.length === 10) d = '7' + d;
  return '+' + d;
}
// Ключ для сравнения номеров — последние 10 цифр (код страны диктуют по-разному)
export function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}
// Клиент с таким же номером (в любом написании)
export async function findByPhoneDigits(raw, exceptId = null) {
  const key = phoneKey(raw);
  if (!key) return null;
  return q1(
    `SELECT * FROM clients
      WHERE right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
        AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY id LIMIT 1`,
    [key, exceptId]
  );
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
export async function createClient({ full_name, phone, app_installed = false, note, kids = [], referrer_code,
                                     onDuplicatePhone = 'error' }) {
  if (!full_name) {
    const err = new Error('Укажите имя клиента');
    err.status = 400;
    throw err;
  }
  // Один телефон — одна карта. Если гость уже в базе, новую карту не заводим:
  // касса откроет существующую (иначе теряются бонусы и история покупок).
  const phoneNorm = phoneCanonical(phone);
  if (phoneNorm) {
    const dup = await findByPhoneDigits(phoneNorm);
    if (dup) {
      if (onDuplicatePhone === 'attach') return { client: dup, referrer: null, existing: true };
      const err = new Error(
        `Клиент с таким телефоном уже есть: ${dup.full_name} (карта ${dup.card_no}). Откройте его карту вместо новой.`
      );
      err.status = 409;
      err.existing = dup;
      throw err;
    }
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
      [full_name, phoneNorm, card_no, app_installed, note || null, referrer ? referrer.id : null]
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
