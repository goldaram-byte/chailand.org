// Слой фискализации (54-ФЗ): единый интерфейс + подключаемые драйверы + очередь.
//
// Логика устойчивости к обрыву связи:
//   • каждый чек сразу пишется в fiscal_docs (status='queued') — он НЕ теряется;
//   • при продаже пробуем зарегистрировать сразу (быстрый путь, когда сеть есть);
//   • если ОФД/интернет недоступны — документ остаётся в очереди, а фоновый
//     воркер (flushFiscalQueue) повторяет отправку с нарастающей паузой, пока
//     ОФД не подтвердит регистрацию. Так чек автоматически уходит в налоговую,
//     как только появляется связь.
//
// Активный драйвер выбирается настройкой settings.fiscal_driver:
//   'emulation' (по умолчанию) | 'taxcom' (ОФД Такском, облачная касса Ferma).
import { q, q1 } from '../db.js';

/**
 * Контракт драйвера фискализации:
 *   async register({ sale, items, payments, kind }) ->
 *     { fnNumber, fdNumber, fp, receiptUrl, raw }
 *   Бросает ошибку при недоступности ОФД — документ останется в очереди.
 */

// ------------------------------ настройки ----------------------------------
async function settingsMap(keys) {
  const rows = await q(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
  const m = {};
  for (const r of rows) {
    const v = r.value;
    m[r.key] = typeof v === 'string' ? v.replace(/^"|"$/g, '') : v;
  }
  return m;
}

// ------------------------------ эмуляция -----------------------------------
let emuCounter = null;
async function nextEmuNumbers() {
  if (emuCounter === null) {
    const row = await q1(`SELECT count(*)::int AS c FROM fiscal_docs WHERE status='registered'`);
    emuCounter = row.c;
  }
  emuCounter += 1;
  return {
    fnNumber: '9999078900' + String(1000 + emuCounter),
    fdNumber: String(emuCounter),
    fp: String(1000000000 + emuCounter * 7),
  };
}

const emulationDriver = {
  name: 'emulation',
  async register({ sale }) {
    const n = await nextEmuNumbers();
    return {
      ...n,
      receiptUrl: `https://ofd-emulation.local/receipt/${n.fdNumber}`,
      raw: { emulated: true, saleId: sale?.id },
    };
  },
};

// ------------------------- ОФД Такском (Ferma) -----------------------------
// Облачная касса Такском Ferma: авторизация → отправка чека → опрос статуса.
// Реквизиты берём из настроек (заполняются после договора с Такском):
//   taxcom_ferma_url, taxcom_login, taxcom_password, taxcom_inn
async function fetchJson(url, opts, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* не-JSON ответ */ }
    if (!res.ok) throw new Error(`ОФД Такском: HTTP ${res.status} ${text.slice(0, 200)}`);
    return json;
  } finally {
    clearTimeout(t);
  }
}

const taxcomDriver = {
  name: 'taxcom',
  async register({ sale, items, payments, kind }) {
    const cfg = await settingsMap(['taxcom_ferma_url', 'taxcom_login', 'taxcom_password', 'taxcom_inn']);
    const base = (cfg.taxcom_ferma_url || '').replace(/\/+$/, '');
    if (!base || !cfg.taxcom_login || !cfg.taxcom_password) {
      throw new Error('ОФД Такском не настроен: укажите URL, логин и пароль в настройках');
    }

    // 1) токен авторизации
    const auth = await fetchJson(`${base}/api/Authorization/CreateAuthToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Login: cfg.taxcom_login, Password: cfg.taxcom_password }),
    });
    const token = auth?.Data?.AuthToken;
    if (!token) throw new Error('ОФД Такском: не получен токен авторизации');

    // 2) отправка чека (приход / возврат прихода)
    const cash = Number(payments?.cash || 0);
    const card = Number(payments?.card || 0);
    const bonus = Number(payments?.bonus || 0);
    const rows = (items || []).map((it) => ({
      Label: it.name,
      Price: Number(it.price),
      Quantity: Number(it.qty || 1),
      Amount: Math.round(Number(it.price) * Number(it.qty || 1) * 100) / 100,
      Vat: 'VatNo',
      PaymentMethod: 4,
      PaymentType: 4,
    }));
    const submit = await fetchJson(`${base}/api/kkt/cloud/receipt?AuthToken=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Request: {
          Inn: cfg.taxcom_inn || undefined,
          Type: kind === 'return' ? 'IncomeReturn' : 'Income',
          InvoiceId: String(sale?.id ?? ''),
          Items: rows,
          PaymentItems: [
            cash > 0 ? { PaymentType: 'Cash', Sum: cash } : null,
            card + bonus > 0 ? { PaymentType: 'Card', Sum: card + bonus } : null,
          ].filter(Boolean),
        },
      }),
    });
    const receiptId = submit?.Data?.ReceiptId;
    if (!receiptId) throw new Error('ОФД Такском: чек не принят (нет ReceiptId)');

    // 3) опрос статуса (ОФД регистрирует асинхронно)
    let status = null;
    for (let i = 0; i < 6; i++) {
      const st = await fetchJson(`${base}/api/kkt/cloud/status?AuthToken=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Request: { ReceiptId: receiptId } }),
      });
      status = st?.Data;
      const code = status?.StatusCode ?? status?.Status;
      if (code === 'CONFIRMED' || code === 2 || status?.Device?.FiscalSign) break;
      if (code === 'FAILED' || code === 3) throw new Error('ОФД Такском: регистрация отклонена');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const dev = status?.Device || {};
    if (!dev.FiscalSign) throw new Error('ОФД Такском: чек ещё не подтверждён, повторим позже');
    return {
      fnNumber: dev.FnNumber || dev.FnFactoryNumber || null,
      fdNumber: dev.DocumentNumber || dev.FiscalDocumentNumber || String(receiptId),
      fp: String(dev.FiscalSign),
      receiptUrl: dev.OfdReceiptUrl || dev.CheckUrl || null,
      raw: { receiptId, device: dev },
    };
  },
};

function stubDriver(name) {
  return {
    name,
    async register() {
      throw new Error(`Драйвер фискализации «${name}» не активирован. Подключите ККТ и ОФД.`);
    },
  };
}

// Штрих-М печатает и фискализирует чек локально, на кассовом ПК (HTTP-драйвер
// на localhost, недоступен серверу через интернет) — кассовое приложение в
// браузере печатает чек само и присылает номера ФН/ФД/ФП через fiscalizeManual().
// Если по какой-то причине браузер не приложил их к продаже — попадаем сюда:
// очередь будет безрезультатно повторять попытки, пока кто-то не разберётся.
const shtrihDriver = stubDriver('shtrih');

const DRIVERS = {
  emulation: () => emulationDriver,
  taxcom: () => taxcomDriver,
  shtrih: () => shtrihDriver,
  atol: () => stubDriver('atol'),
};

async function resolveDriver() {
  const row = await q1(`SELECT value FROM settings WHERE key = 'fiscal_driver'`);
  let name = 'emulation';
  if (row?.value != null) {
    name = typeof row.value === 'string' ? row.value.replace(/^"|"$/g, '') : row.value;
  }
  const make = DRIVERS[name];
  return make ? make() : emulationDriver;
}

// Пауза перед следующей попыткой: 30с, 1м, 2м, 5м (потолок).
function backoffSeconds(attempts) {
  return [30, 60, 120, 300][Math.min(attempts, 3)] || 300;
}

// Зарегистрировать один документ очереди. Обновляет строку fiscal_docs.
async function tryRegister(doc) {
  const driver = await resolveDriver();
  const payload = doc.payload || {};
  const r = await driver.register({
    sale: { id: doc.sale_id },
    items: payload.items || [],
    payments: payload.payments || {},
    kind: doc.kind,
  });
  await q(
    `UPDATE fiscal_docs
        SET status='registered', driver=$2, fn_number=$3, fd_number=$4, fp=$5,
            ofd_receipt_url=$6, registered_at=now(), error=NULL, next_attempt_at=NULL
      WHERE id=$1`,
    [doc.id, driver.name, r.fnNumber, r.fdNumber, r.fp, r.receiptUrl]
  );
  return { id: doc.id, status: 'registered', ...r, driver: driver.name };
}

async function markRetry(doc, err) {
  const attempts = (doc.attempts || 0) + 1;
  await q(
    `UPDATE fiscal_docs
        SET status='error', error=$2, attempts=$3, last_attempt_at=now(),
            next_attempt_at = now() + ($4 || ' seconds')::interval
      WHERE id=$1`,
    [doc.id, err.message, attempts, String(backoffSeconds(attempts))]
  );
}

/**
 * Записать чек, который уже пробит и фискализирован локально на кассе
 * (Штрих-М: касса в браузере напечатала его через HTTP-драйвер на localhost
 * и прислала настоящие номера ФН/ФД/ФП с устройства). В отличие от
 * fiscalize(), сервер сюда никуда не стучится — просто сохраняет результат.
 */
export async function fiscalizeManual({ sale, kind = 'sale', driver = 'shtrih', fnNumber, fdNumber, fp, receiptUrl }) {
  if (!fnNumber || !fdNumber || !fp) {
    throw new Error('Не хватает данных фискального чека (ФН/ФД/ФП) с кассового устройства');
  }
  const doc = await q1(
    `INSERT INTO fiscal_docs (sale_id, kind, status, driver, fn_number, fd_number, fp, ofd_receipt_url, registered_at)
     VALUES ($1,$2,'registered',$3,$4,$5,$6,$7, now()) RETURNING *`,
    [sale.id, kind, driver, String(fnNumber), String(fdNumber), String(fp), receiptUrl || null]
  );
  return { id: doc.id, status: 'registered', fnNumber, fdNumber, fp, receiptUrl: receiptUrl || null, driver };
}

/**
 * Зарегистрировать чек. Пишет запись в fiscal_docs и пробует отправить сразу.
 * Ошибка регистрации НЕ откатывает продажу: чек остаётся в очереди и будет
 * отправлен фоновым воркером, как только появится связь с ОФД.
 */
export async function fiscalize({ sale, items, payments, kind = 'sale' }) {
  const doc = await q1(
    `INSERT INTO fiscal_docs (sale_id, kind, status, driver, payload, next_attempt_at)
     VALUES ($1,$2,'queued','pending',$3, now()) RETURNING *`,
    [sale.id, kind, JSON.stringify({ items, payments })]
  );
  try {
    return await tryRegister(doc);
  } catch (err) {
    await markRetry(doc, err);
    return { id: doc.id, status: 'queued', error: err.message };
  }
}

// --------------------------- фоновый воркер --------------------------------
let flushing = false;

/**
 * Разобрать очередь: попытаться отправить в ОФД все документы, у которых
 * подошло время следующей попытки. Возвращает сводку {registered, failed}.
 * Захватывает документ (status='sending') атомарно, чтобы не отправить дважды.
 */
export async function flushFiscalQueue({ limit = 50 } = {}) {
  if (flushing) return { skipped: true };
  flushing = true;
  let registered = 0, failed = 0;
  try {
    const due = await q(
      `SELECT id FROM fiscal_docs
        WHERE status IN ('queued','error','sending')
          AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        ORDER BY created_at
        LIMIT $1`,
      [limit]
    );
    for (const { id } of due) {
      // атомарный захват документа
      const doc = await q1(
        `UPDATE fiscal_docs SET status='sending', last_attempt_at=now()
          WHERE id=$1 AND status IN ('queued','error','sending') RETURNING *`,
        [id]
      );
      if (!doc) continue;
      try {
        await tryRegister(doc);
        registered += 1;
      } catch (err) {
        await markRetry(doc, err);
        failed += 1;
      }
    }
    return { registered, failed, checked: due.length };
  } finally {
    flushing = false;
  }
}

/** Запустить периодический разбор очереди ОФД. Возвращает функцию остановки. */
export function startFiscalWorker(intervalMs = 30000) {
  const tick = () => { flushFiscalQueue().catch((e) => console.error('[fiscal] очередь:', e.message)); };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick(); // первый прогон сразу
  return () => clearInterval(timer);
}
