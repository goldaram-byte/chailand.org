// Слой эквайринга: единый интерфейс + подключаемые драйверы банков.
// Сейчас активна эмуляция; после подключения терминала и договора с банком
// добавляется реальный драйвер (Сбербанк/ВТБ) без изменения кода кассы.
import { q1 } from '../db.js';

/**
 * Контракт драйвера эквайринга:
 *   async pay({ amount, orderId }) -> { approved, rrn, authCode, raw }
 *   async refund({ amount, orderId, rrn }) -> { approved, rrn, raw }
 */

const emulationDriver = {
  name: 'emulation',
  async pay({ amount, orderId }) {
    // Мгновенно «одобряем» — терминала нет, это демонстрационный режим.
    return {
      approved: true,
      rrn: 'EMU' + String(orderId).padStart(8, '0'),
      authCode: '000000',
      raw: { emulated: true, amount },
    };
  },
  async refund({ amount, orderId, rrn }) {
    return { approved: true, rrn: rrn || 'EMU' + String(orderId).padStart(8, '0'), raw: { emulated: true, amount } };
  },
};

// Заготовки реальных драйверов — включаются, когда появятся реквизиты/эквайринг.
// Пока бросают понятную ошибку, чтобы касса откатилась на выбор оплаты.
function stubDriver(bank) {
  return {
    name: bank,
    async pay() {
      throw new Error(`Драйвер эквайринга «${bank}» не активирован. Подключите терминал и договор.`);
    },
    async refund() {
      throw new Error(`Драйвер эквайринга «${bank}» не активирован.`);
    },
  };
}

const REAL_DRIVERS = {
  sber: () => stubDriver('sber'),
  vtb: () => stubDriver('vtb'),
};

/** Текущая конфигурация эквайринга из БД. */
export async function getAcquiringConfig() {
  return q1('SELECT * FROM acquiring_config WHERE id = 1');
}

/** Выбор драйвера по режиму/банку. */
export async function resolveDriver() {
  const cfg = await getAcquiringConfig();
  if (!cfg || cfg.mode === 'emulation' || !cfg.connected) return emulationDriver;
  const make = REAL_DRIVERS[cfg.bank];
  return make ? make() : emulationDriver;
}

export async function acquiringPay({ amount, orderId }) {
  const driver = await resolveDriver();
  const res = await driver.pay({ amount, orderId });
  return { driver: driver.name, ...res };
}

export async function acquiringRefund({ amount, orderId, rrn }) {
  const driver = await resolveDriver();
  const res = await driver.refund({ amount, orderId, rrn });
  return { driver: driver.name, ...res };
}
