import { pool, q, q1 } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './auth.js';

// Демо-пароли (в проде сменить). Логин: owner / admin / cashier
const USERS = [
  { full_name: 'Владелец', login: 'owner', pass: 'owner123', role: 'owner', phone: '+7 900 000-00-01' },
  { full_name: 'Администратор', login: 'admin', pass: 'admin123', role: 'admin', phone: '+7 900 000-00-02' },
  { full_name: 'Кассир', login: 'cashier', pass: 'cashier123', role: 'cashier', phone: '+7 900 000-00-03' },
];

// Точки продаж (ТЦ) — Чайлэнд работает в двух ТЦ в Люберцах.
// Названия можно переименовать в админке (Настройки → Точки).
const LOCATIONS = [
  ['ТЦ Светофор', 'Люберцы'],
  ['ТЦ Выходной', 'Люберцы'],
];

const ROLES = [
  { code: 'owner', name: 'Владелец', permissions: ['*'], sort: 1 },
  {
    code: 'admin',
    name: 'Администратор',
    permissions: ['pos', 'returns', 'shifts', 'clients', 'crm', 'bookings', 'reports', 'catalog', 'skud', 'news'],
    sort: 2,
  },
  { code: 'cashier', name: 'Кассир', permissions: ['pos', 'returns', 'shifts', 'clients', 'crm', 'bookings', 'reports'], sort: 3 },
];

const GROUPS = [
  { name: 'Билеты', kind: 'tickets', sort: 1 },
  { name: 'Кафе', kind: 'cafe', sort: 2 },
  { name: 'Сувениры', kind: 'goods', sort: 3 },
];

// day: weekday | friday | weekend | any ; groupIdx — индекс в GROUPS
const PRODUCTS = [
  ['Будний день (Пн–Чт)', 'weekday', 790, false, 0],
  ['Почти выходной (Пятница)', 'friday', 990, false, 0],
  ['Выходные и праздники', 'weekend', 1190, false, 0],
  ['Многодетным (Пн–Чт)', 'weekday', 550, true, 0],
  ['Многодетным (Пятница/предпраздничные)', 'friday', 690, true, 0],
  ['Многодетным (выходные/праздники)', 'weekend', 850, true, 0],
  ['Особенным детям (Пн–Чт)', 'weekday', 550, true, 0],
  ['Особенным детям (Пятница/предпраздничные)', 'friday', 690, true, 0],
  ['Особенным детям (выходные/праздники)', 'weekend', 850, true, 0],
  ['Малыш до 1 года (при оплате за второго ребёнка)', 'any', 0, true, 0],
  ['Попкорн', 'any', 250, false, 1],
  ['Лимонад', 'any', 150, false, 1],
  ['Сахарная вата', 'any', 200, false, 1],
  ['Хот-дог', 'any', 280, false, 1],
  ['Магнит', 'any', 300, false, 2],
  ['Мягкая игрушка', 'any', 600, false, 2],
  ['Значок «Чайлэнд»', 'any', 150, false, 2],
];

const SERVICES = [
  ['Аниматор (1 час)', 3500],
  ['Шоу-программа', 5000],
  ['Фотозона', 2500],
  ['Кэнди-бар', 4000],
  ['Шар-сюрприз', 2000],
  ['Оформление шарами', 3000],
  ['Фотоуслуги (1 час)', 3500],
  ['Аквагрим (до 10 детей)', 1500],
];

const ROOMS = [
  ['Банкетная №1', 15],
  ['Банкетная №2', 15],
];

const SETTINGS = [
  ['park_name', '"Чайлэнд"'],
  ['cashback', '5'],
  ['holidays', '[]'],
  ['loyalty_max_pay_percent', '50'],
  // Реферальная программа «Приведи друга»
  ['referral_enabled', 'false'],
  // Пригласившему — процент от первой покупки друга
  ['referral_referrer_percent', '10'],
  ['referral_referee_bonus', '100'],
  // KPI сотрудников кассы (цели за период)
  ['kpi_targets', '{"revenue":300000,"checks":300,"avg_check":800}'],
  // Фискализация (54-ФЗ). Драйвер: emulation | taxcom (ОФД Такском, касса Ferma).
  ['fiscal_driver', '"emulation"'],
  ['taxcom_ferma_url', '"https://ferma.ofd.ru"'],
  ['taxcom_login', '""'],
  ['taxcom_password', '""'],
  ['taxcom_inn', '""'],
  // СКУД: токен для терминала отпечатков (сменить на свой!)
  ['skud_device_token', '"CHANGE-ME-SKUD-TOKEN"'],
  // Рабочее окно для расчёта ЗП: часы вне 10:00–22:00 не оплачиваются (МСК, +3)
  ['payroll_window_start', '"10:00"'],
  ['payroll_window_end', '"22:00"'],
  ['payroll_tz_offset', '3'],
];

// Демо-новости (загружаются один раз, если таблица пуста)
const NEWS = [
  ['🚀 Открытие сезона в «Чайлэнд»!', 'Мы ждём вас каждый день с 10:00 до 22:00. Новые аттракционы, космическое шоу и подарки первым гостям!', '🚀', true, true],
  ['🎉 Приведи друга — получи бонусы', 'Поделитесь своим кодом в приложении. Друг регистрируется и совершает первую покупку — вам начисляются бонусы на карту.', '🎁', false, true],
  ['🎂 Дни рождения под ключ', 'Аниматоры, шоу-программа, фотозона и торт. Оставьте заявку в приложении — администратор перезвонит и всё организует.', '🎂', false, true],
];

const LEADS = [
  ['Ольга Петрова', '+7 903 111-22-33', 'Instagram', 'new', 'Хочет день рождения на 10 детей'],
  ['Игорь Волков', '+7 904 222-33-44', 'Сайт', 'contact', 'Считаем смету на аниматора'],
  ['Анна Кузнецова', '+7 905 333-44-55', 'Рекомендация', 'booking', 'Праздник 12 июля, банкетная №1'],
  ['Дмитрий Соколов', '+7 906 444-55-66', '2ГИС', 'lost', 'Дорого, ушёл к конкурентам'],
];

export async function seed() {
  // Роли — upsert
  for (const r of ROLES) {
    await q(
      `INSERT INTO roles (code, name, permissions, sort) VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions, sort = EXCLUDED.sort`,
      [r.code, r.name, JSON.stringify(r.permissions), r.sort]
    );
  }

  // Пользователи — только если логина ещё нет. Существующих НЕ трогаем
  // (имена, роли, пароли, добавленных сотрудников сохраняем при обновлениях).
  for (const u of USERS) {
    await q(
      `INSERT INTO users (full_name, phone, login, pass_hash, role_code)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (login) DO NOTHING`,
      [u.full_name, u.phone, u.login, hashPassword(u.pass), u.role]
    );
  }

  // Настройки — upsert
  for (const [k, v] of SETTINGS) {
    await q(`INSERT INTO settings (key, value) VALUES ($1,$2::jsonb)
             ON CONFLICT (key) DO NOTHING`, [k, v]);
  }

  // Эквайринг — singleton
  await q(
    `INSERT INTO acquiring_config (id, bank, mode, connected) VALUES (1, NULL, 'emulation', false)
     ON CONFLICT (id) DO NOTHING`
  );

  // Каталог — только если пусто
  const groupsCount = (await q1('SELECT count(*)::int AS c FROM product_groups')).c;
  if (groupsCount === 0) {
    const groupIds = [];
    for (const g of GROUPS) {
      const row = await q1(
        'INSERT INTO product_groups (name, kind, sort) VALUES ($1,$2,$3) RETURNING id',
        [g.name, g.kind, g.sort]
      );
      groupIds.push(row.id);
    }
    let sort = 0;
    for (const [name, day, price, doc, gi] of PRODUCTS) {
      await q(
        `INSERT INTO products (group_id, name, day_kind, price, requires_document, sort)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [groupIds[gi], name, day, price, doc, sort++]
      );
    }
    for (const [name, price] of SERVICES) {
      await q('INSERT INTO services (name, price) VALUES ($1,$2)', [name, price]);
    }
    for (const [name, cap] of ROOMS) {
      await q('INSERT INTO rooms (name, capacity) VALUES ($1,$2)', [name, cap]);
    }
  }

  // Точки (ТЦ) — только если пусто
  const locCount = (await q1('SELECT count(*)::int AS c FROM locations')).c;
  if (locCount === 0) {
    let ls = 0;
    for (const [name, address] of LOCATIONS) {
      await q('INSERT INTO locations (name, address, sort) VALUES ($1,$2,$3)', [name, address, ls++]);
    }
  }

  // Клиенты — только если пусто
  const clientsCount = (await q1('SELECT count(*)::int AS c FROM clients')).c;
  if (clientsCount === 0) {
    const c1 = await q1(
      `INSERT INTO clients (full_name, phone, card_no, bonus, app_installed, referral_code)
       VALUES ('Мария Иванова','+7 900 123-45-67','000001',40,true,'900001') RETURNING id`
    );
    const c2 = await q1(
      `INSERT INTO clients (full_name, phone, card_no, bonus, app_installed, referral_code)
       VALUES ('Пётр Смирнов','+7 901 555-11-22','000002',120,false,'900002') RETURNING id`
    );
    await q(`INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,'Соня','2017-07-15')`, [c1.id]);
    await q(`INSERT INTO client_kids (client_id, name, birth_date) VALUES ($1,'Артём','2017-11-03')`, [c2.id]);
    await q(`INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,40,'Приветственный бонус')`, [c1.id]);
    await q(`INSERT INTO loyalty_transactions (client_id, points, reason) VALUES ($1,120,'Накопленный кэшбэк')`, [c2.id]);
  }

  // Лиды — только если пусто
  const leadsCount = (await q1('SELECT count(*)::int AS c FROM leads')).c;
  if (leadsCount === 0) {
    for (const [name, phone, source, status, note] of LEADS) {
      await q(
        `INSERT INTO leads (name, phone, source, status, note) VALUES ($1,$2,$3,$4,$5)`,
        [name, phone, source, status, note]
      );
    }
  }

  // Новости — только если пусто
  const newsCount = (await q1('SELECT count(*)::int AS c FROM news')).c;
  if (newsCount === 0) {
    for (const [title, body, cover, pinned, published] of NEWS) {
      await q('INSERT INTO news (title, body, cover, pinned, published) VALUES ($1,$2,$3,$4,$5)', [title, body, cover, pinned, published]);
    }
  }

  // Выдать реферальный код всем клиентам, у кого его ещё нет
  await q(`UPDATE clients SET referral_code = '9' || lpad(id::text, 5, '0') WHERE referral_code IS NULL`);

  // СКУД: завести персонал из учёток пользователей (один раз, если пусто)
  const personnelCount = (await q1('SELECT count(*)::int AS c FROM personnel')).c;
  if (personnelCount === 0) {
    const posByRole = { owner: 'Владелец', admin: 'Администратор', cashier: 'Кассир' };
    const users = await q('SELECT id, full_name, phone, role_code FROM users');
    for (const u of users) {
      await q(
        `INSERT INTO personnel (full_name, position, phone, user_id) VALUES ($1,$2,$3,$4)`,
        [u.full_name, posByRole[u.role_code] || u.role_code, u.phone, u.id]
      );
    }
  }

  console.log('[seed] демо-данные загружены (пользователи: owner/admin/cashier, пароли *123)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => seed())
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[seed] ошибка:', err.message);
      process.exit(1);
    });
}
