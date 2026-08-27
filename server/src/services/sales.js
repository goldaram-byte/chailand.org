// Общая бизнес-логика продаж и возвратов.
// Используется и онлайн-кассой (routes/pos.js), и офлайн-синхронизацией (routes/sync.js),
// поэтому идемпотентность (client_uuid) и лояльность живут здесь, в одном месте.
import { q, q1, tx } from '../db.js';
import { fiscalize, fiscalizeManual } from './fiscal.js';
import { acquiringPay, acquiringRefund } from './acquiring.js';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function cashbackPercent() {
  const row = await q1(`SELECT value FROM settings WHERE key='cashback'`);
  return Number(row?.value ?? 5);
}

// Реферальная программа: пригласившему начисляется процент от первой покупки
// приглашённого. Читаем флаг и процент.
async function referralReward() {
  const rows = await q(
    `SELECT key, value FROM settings WHERE key IN ('referral_enabled','referral_referrer_percent')`
  );
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return {
    enabled: m.referral_enabled === true || m.referral_enabled === 'true',
    percent: Number(m.referral_referrer_percent || 0),
  };
}

export async function loadSale(id) {
  const sale = await q1('SELECT * FROM sales WHERE id=$1', [id]);
  if (!sale) return null;
  const items = await q('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id', [id]);
  const fiscal = await q1(
    'SELECT id,status,fd_number,fp,ofd_receipt_url FROM fiscal_docs WHERE sale_id=$1 ORDER BY id DESC LIMIT 1',
    [id]
  );
  return { ...sale, items, fiscal: fiscal || null };
}

/**
 * Оформить продажу. user = {id}. Возвращает объект продажи.
 * Идемпотентно по client_uuid.
 */
export async function createSale(user, body) {
  const {
    client_uuid,
    items = [],
    cash_amount = 0,
    card_amount = 0,
    bonus_used = 0,
    client_id = null,
    method,
    comment,
    location_id = null,
    fiscal: fiscalReceipt = null, // чек, уже пробитый локально на кассе (Штрих-М)
  } = body || {};

  if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'Чек пуст');

  if (client_uuid) {
    const dup = await q1('SELECT id FROM sales WHERE client_uuid=$1', [client_uuid]);
    if (dup) return { ...(await loadSale(dup.id)), idempotent: true };
  }

  // Абонемент — такая же позиция чека, как билет или товар, но выдаётся он
  // на карту клиента: без клиента в чеке оформить его нельзя.
  const passItems = items.filter((it) => it.pass_type_id);
  const passTypes = {};
  if (passItems.length) {
    if (!client_id) throw new ApiError(400, 'Абонемент оформляется на карту клиента — добавьте клиента в чек');
    for (const it of passItems) {
      if (passTypes[it.pass_type_id]) continue;
      const t = await q1('SELECT * FROM pass_types WHERE id=$1 AND is_active', [it.pass_type_id]);
      if (!t) throw new ApiError(404, 'Вид абонемента не найден или отключён');
      passTypes[it.pass_type_id] = t;
    }
  }

  const total = items.reduce((a, it) => a + Number(it.price) * Number(it.qty || 1), 0);
  const paid = Number(cash_amount) + Number(card_amount) + Number(bonus_used);
  if (Math.abs(paid - total) > 0.01) {
    throw new ApiError(400, `Сумма оплаты (${paid}) не равна итогу чека (${total})`);
  }

  if (Number(bonus_used) > 0) {
    if (!client_id) throw new ApiError(400, 'Оплата бонусами возможна только для клиента с картой');
    const cl = await q1('SELECT bonus FROM clients WHERE id=$1', [client_id]);
    if (!cl || Number(cl.bonus) < Number(bonus_used)) throw new ApiError(400, 'Недостаточно бонусов на карте');
    // Лимит оплаты бонусами — свой у каждой точки (ТЦ)
    const loc = location_id ? await q1('SELECT bonus_spend_percent FROM locations WHERE id=$1', [location_id]) : null;
    const pct = loc ? Number(loc.bonus_spend_percent) : 100;
    if (pct < 100) {
      const limit = Math.floor((total * pct) / 100);
      if (Number(bonus_used) > limit) {
        throw new ApiError(400, `Бонусами можно оплатить не более ${pct}% чека — это ${limit} ₽`);
      }
    }
  }

  const percent = await cashbackPercent();
  const bonusEarned = client_id ? Math.floor((total - Number(bonus_used)) * (percent / 100)) : 0;
  const payMethod =
    method ||
    (Number(card_amount) > 0 && Number(cash_amount) > 0
      ? 'mixed'
      : Number(card_amount) > 0
        ? 'card'
        : Number(bonus_used) >= total
          ? 'bonus'
          : 'cash');

  let acq = null;
  if (Number(card_amount) > 0) {
    acq = await acquiringPay({ amount: Number(card_amount), orderId: client_uuid || Date.now() });
    if (!acq.approved) throw new ApiError(402, 'Оплата картой отклонена терминалом');
  }

  const ref = client_id ? await referralReward() : null;

  const shift = await q1(`SELECT id, location_id FROM cash_shifts WHERE closed_at IS NULL AND cashier_id=$1`, [user.id]);
  // Точка (ТЦ): приоритет — явно переданная устройством, иначе из открытой смены.
  const saleLocation = location_id || shift?.location_id || null;

  const saleId = await tx(async ({ q1: cq1, q: cq }) => {
    const sale = await cq1(
      `INSERT INTO sales (client_uuid, shift_id, cashier_id, client_id, total, cash_amount, card_amount,
                          bonus_used, bonus_earned, method, comment, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [client_uuid || null, shift?.id || null, user.id, client_id, total, cash_amount, card_amount, bonus_used, bonusEarned, payMethod, comment || null, saleLocation]
    );
    for (const it of items) {
      await cq(
        `INSERT INTO sale_items (sale_id, product_id, group_id, name, qty, price, sum, pass_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [sale.id, it.product_id || null, it.group_id || null, it.name, it.qty || 1, it.price, Number(it.price) * Number(it.qty || 1), it.pass_type_id || null]
      );
      // Абонементы выдаём здесь же: сколько штук в позиции — столько и карт.
      if (it.pass_type_id) {
        const t = passTypes[it.pass_type_id];
        const tLocs = (t.location_ids || []).map(Number);
        for (let i = 0; i < Number(it.qty || 1); i++) {
          await cq(
            `INSERT INTO passes (pass_type_id, client_id, name, visits_total, visits_left,
                                 valid_to, sale_id, location_id, location_ids, sold_by)
             VALUES ($1,$2,$3,$4,$4, current_date + ($5 || ' days')::interval, $6, $7, $8, $9)`,
            [t.id, client_id, t.name, t.visits || null, String(t.valid_days || 30),
             sale.id, saleLocation || tLocs[0] || null, tLocs, user.id]
          );
        }
      }
      // Складской учёт: списываем остаток у товаров с учётом (track_stock).
      if (it.product_id) {
        const qty = Number(it.qty || 1);
        const tracked = await cq1(
          `UPDATE products SET stock = stock - $2 WHERE id=$1 AND track_stock RETURNING id`,
          [it.product_id, qty]
        );
        if (tracked) {
          await cq(
            `INSERT INTO stock_moves (product_id, delta, reason, note, created_by) VALUES ($1,$2,'sale',$3,$4)`,
            [it.product_id, -qty, 'Продажа №' + sale.id, user.id]
          );
        }
      }
    }
    if (client_id) {
      if (Number(bonus_used) > 0) {
        await cq('INSERT INTO loyalty_transactions (client_id, sale_id, points, reason) VALUES ($1,$2,$3,$4)', [
          client_id, sale.id, -Number(bonus_used), 'Оплата бонусами',
        ]);
      }
      if (bonusEarned > 0) {
        await cq('INSERT INTO loyalty_transactions (client_id, sale_id, points, reason) VALUES ($1,$2,$3,$4)', [
          client_id, sale.id, bonusEarned, `Кэшбэк ${percent}%`,
        ]);
      }
      await cq('UPDATE clients SET bonus = bonus - $2 + $3 WHERE id=$1', [client_id, Number(bonus_used), bonusEarned]);

      // «Приведи друга»: за первую покупку приглашённого пригласившему
      // начисляется процент от суммы этой покупки.
      if (ref && ref.enabled && ref.percent > 0) {
        const c = await cq1('SELECT referred_by, referral_rewarded FROM clients WHERE id=$1', [client_id]);
        if (c && c.referred_by && !c.referral_rewarded) {
          const reward = Math.floor((total * ref.percent) / 100);
          if (reward > 0) {
            await cq('INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,$2,$3)', [
              c.referred_by, reward, 'Бонус за покупку приглашённого друга (' + ref.percent + '%)',
            ]);
            await cq('UPDATE clients SET bonus = bonus + $2 WHERE id=$1', [c.referred_by, reward]);
          }
          await cq('UPDATE clients SET referral_rewarded = true WHERE id=$1', [client_id]);
        }
      }
    }
    return sale.id;
  });

  const fiscal = fiscalReceipt
    ? await fiscalizeManual({ sale: { id: saleId }, kind: 'sale', ...fiscalReceipt })
    : await fiscalize({
        sale: { id: saleId },
        items,
        payments: { cash: cash_amount, card: card_amount, bonus: bonus_used },
        kind: 'sale',
      });

  return { ...(await loadSale(saleId)), acquiring: acq, fiscal };
}

/** Полный возврат продажи. Идемпотентно по client_uuid. */
export async function createReturn(user, body) {
  const { parent_sale_id, parent_client_uuid, reason, client_uuid, fiscal: fiscalReceipt = null } = body || {};
  if (!parent_sale_id && !parent_client_uuid) throw new ApiError(400, 'Не указана продажа для возврата');

  if (client_uuid) {
    const dup = await q1('SELECT id FROM sales WHERE client_uuid=$1', [client_uuid]);
    if (dup) return { ...(await loadSale(dup.id)), idempotent: true };
  }

  // Родительскую продажу можно указать по серверному id либо по client_uuid
  // (последнее нужно офлайн-кассе, которая не знает серверных id).
  const parent = parent_sale_id
    ? await q1('SELECT * FROM sales WHERE id=$1', [parent_sale_id])
    : await q1('SELECT * FROM sales WHERE client_uuid=$1', [parent_client_uuid]);
  if (!parent) throw new ApiError(404, 'Исходная продажа не найдена');
  if (parent.status === 'returned') throw new ApiError(409, 'Продажа уже возвращена');
  // ВАЖНО: позиции ищем по id найденной продажи (parent.id), а не по параметру
  // запроса — при возврате по parent_client_uuid параметр parent_sale_id пуст,
  // и раньше возвратный чек создавался без состава (и без возврата на склад).
  const parentItems = await q('SELECT * FROM sale_items WHERE sale_id=$1', [parent.id]);

  let acq = null;
  if (Number(parent.card_amount) > 0) {
    acq = await acquiringRefund({ amount: Number(parent.card_amount), orderId: parent.id });
  }

  const retId = await tx(async ({ q1: cq1, q: cq }) => {
    const ret = await cq1(
      `INSERT INTO sales (client_uuid, shift_id, cashier_id, client_id, total, cash_amount, card_amount,
                          bonus_used, bonus_earned, method, status, is_return, parent_sale_id, comment, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'done',true,$11,$12,$13) RETURNING id`,
      [client_uuid || null, parent.shift_id, user.id, parent.client_id, -Number(parent.total), -Number(parent.cash_amount), -Number(parent.card_amount), 0, -Number(parent.bonus_earned), parent.method, parent.id, reason || null, parent.location_id || null]
    );
    for (const it of parentItems) {
      await cq(
        `INSERT INTO sale_items (sale_id, product_id, group_id, name, qty, price, sum, pass_type_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ret.id, it.product_id, it.group_id, it.name, -Number(it.qty), it.price, -Number(it.sum), it.pass_type_id || null]
      );
      // Возврат товара с учётом остатков — вернуть на склад.
      if (it.product_id) {
        const qty = Number(it.qty);
        const tracked = await cq1(
          `UPDATE products SET stock = stock + $2 WHERE id=$1 AND track_stock RETURNING id`,
          [it.product_id, qty]
        );
        if (tracked) {
          await cq(
            `INSERT INTO stock_moves (product_id, delta, reason, note, created_by) VALUES ($1,$2,'return',$3,$4)`,
            [it.product_id, qty, 'Возврат продажи №' + parent.id, user.id]
          );
        }
      }
    }
    if (parent.client_id) {
      const delta = Number(parent.bonus_used) - Number(parent.bonus_earned);
      if (delta !== 0) {
        await cq('INSERT INTO loyalty_transactions (client_id, sale_id, points, reason) VALUES ($1,$2,$3,$4)', [
          parent.client_id, ret.id, delta, 'Возврат продажи',
        ]);
        await cq('UPDATE clients SET bonus = bonus + $2 WHERE id=$1', [parent.client_id, delta]);
      }
    }
    // Возврат чека аннулирует выданные по нему абонементы
    await cq(`UPDATE passes SET status='cancelled' WHERE sale_id=$1 AND status <> 'cancelled'`, [parent.id]);
    await cq(`UPDATE sales SET status='returned' WHERE id=$1`, [parent.id]);
    return ret.id;
  });

  const fiscal = fiscalReceipt
    ? await fiscalizeManual({ sale: { id: retId }, kind: 'return', ...fiscalReceipt })
    : await fiscalize({
        sale: { id: retId },
        items: parentItems,
        payments: { cash: -parent.cash_amount, card: -parent.card_amount, bonus: -parent.bonus_used },
        kind: 'return',
      });

  return { ...(await loadSale(retId)), acquiring: acq, fiscal };
}

export { ApiError };
