-- Схема БД админ-панели парка «Габрилеон».
-- Идемпотентная: безопасно выполнять повторно (CREATE ... IF NOT EXISTS).

-- ---------------------------------------------------------------------------
-- Роли и пользователи (пункт 2: авторизация, роли, мультипользовательский режим)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
  code        text PRIMARY KEY,               -- owner | admin | cashier
  name        text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '[]',     -- список разрешений или ["*"]
  sort        int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name   text NOT NULL,
  phone       text,
  login       text NOT NULL UNIQUE,
  pass_hash   text NOT NULL,
  role_code   text NOT NULL REFERENCES roles(code),
  -- индивидуальные переопределения разрешений поверх роли (может быть NULL)
  perm_override jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint REFERENCES users(id),
  action     text NOT NULL,                    -- login, sale.create, return.create, ...
  entity     text,
  entity_id  text,
  meta       jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ---------------------------------------------------------------------------
-- Каталог: группы продаж, товары/тарифы, услуги, комнаты
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_groups (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  text NOT NULL,
  kind  text NOT NULL DEFAULT 'goods',         -- tickets | cafe | goods
  sort  int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id          bigint REFERENCES product_groups(id),
  name              text NOT NULL,
  day_kind          text,                       -- weekday | friday | weekend | any (для билетов)
  price             numeric(12,2) NOT NULL DEFAULT 0,
  requires_document boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true,
  sort              int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(group_id);

CREATE TABLE IF NOT EXISTS services (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL,
  price     numeric(12,2) NOT NULL DEFAULT 0,
  unit      text NOT NULL DEFAULT 'шт',
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS rooms (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      text NOT NULL,
  capacity  int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------------
-- Клиенты, дети, лояльность
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clients (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name     text NOT NULL,
  phone         text UNIQUE,
  card_no       text UNIQUE,                    -- GAB-XXXX
  bonus         numeric(12,2) NOT NULL DEFAULT 0,
  app_installed boolean NOT NULL DEFAULT false,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS client_kids (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name       text NOT NULL,
  birth_date date
);
CREATE INDEX IF NOT EXISTS idx_kids_client ON client_kids(client_id);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id  bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  sale_id    bigint,
  points     numeric(12,2) NOT NULL,            -- + начисление / − списание
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_client ON loyalty_transactions(client_id);

-- ---------------------------------------------------------------------------
-- Касса: смены, продажи, позиции, возвраты (идемпотентность через client_uuid)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cash_shifts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cashier_id bigint NOT NULL REFERENCES users(id),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  cash_start numeric(12,2) NOT NULL DEFAULT 0,
  cash_end   numeric(12,2),
  note       text
);
CREATE INDEX IF NOT EXISTS idx_shifts_cashier ON cash_shifts(cashier_id);

CREATE TABLE IF NOT EXISTS sales (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_uuid    uuid UNIQUE,                   -- идемпотентность офлайн-синхронизации
  shift_id       bigint REFERENCES cash_shifts(id),
  cashier_id     bigint REFERENCES users(id),
  client_id      bigint REFERENCES clients(id),
  total          numeric(12,2) NOT NULL DEFAULT 0,
  cash_amount    numeric(12,2) NOT NULL DEFAULT 0,
  card_amount    numeric(12,2) NOT NULL DEFAULT 0,
  bonus_used     numeric(12,2) NOT NULL DEFAULT 0,
  bonus_earned   numeric(12,2) NOT NULL DEFAULT 0,
  method         text NOT NULL DEFAULT 'cash',  -- cash | card | mixed | bonus
  status         text NOT NULL DEFAULT 'done',  -- done | returned | partial_return
  is_return      boolean NOT NULL DEFAULT false,
  parent_sale_id bigint REFERENCES sales(id),
  comment        text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id    bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id bigint REFERENCES products(id),
  group_id   bigint REFERENCES product_groups(id),
  name       text NOT NULL,
  qty        numeric(12,3) NOT NULL DEFAULT 1,
  price      numeric(12,2) NOT NULL DEFAULT 0,
  sum        numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_items_group ON sale_items(group_id);

-- ---------------------------------------------------------------------------
-- CRM: лиды (воронка) и задачи
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS leads (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  phone      text,
  source     text,                              -- сайт, звонок, инстаграм...
  status     text NOT NULL DEFAULT 'new',       -- new | contact | booking | won | lost
  amount     numeric(12,2) NOT NULL DEFAULT 0,
  note       text,
  client_id  bigint REFERENCES clients(id),     -- после перевода в базу
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);

CREATE TABLE IF NOT EXISTS lead_tasks (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id    bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  title      text NOT NULL,
  due_date   date,
  done       boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_tasks_lead ON lead_tasks(lead_id);

-- ---------------------------------------------------------------------------
-- Бронирование праздников
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bookings (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_name text NOT NULL,
  phone       text,
  date        date NOT NULL,
  time        text,
  room_id     bigint REFERENCES rooms(id),
  service_ids jsonb NOT NULL DEFAULT '[]',
  kids_count  int NOT NULL DEFAULT 0,
  comment     text,
  status      text NOT NULL DEFAULT 'new',      -- new | confirmed | done | cancelled
  prepay      numeric(12,2) NOT NULL DEFAULT 0,
  total       numeric(12,2) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);

-- ---------------------------------------------------------------------------
-- Настройки, эквайринг (пункт 4)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS acquiring_config (
  id          int PRIMARY KEY DEFAULT 1,
  bank        text,                              -- sber | vtb | ...
  terminal_id text,
  merchant_id text,
  mode        text NOT NULL DEFAULT 'emulation', -- emulation | real
  connected   boolean NOT NULL DEFAULT false,
  extra       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquiring_singleton CHECK (id = 1)
);

-- ---------------------------------------------------------------------------
-- Фискализация (пункт 4): очередь чеков и статусы регистрации в ОФД
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fiscal_docs (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sale_id        bigint REFERENCES sales(id) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'sale',   -- sale | return
  status         text NOT NULL DEFAULT 'queued', -- queued | registered | error
  driver         text NOT NULL DEFAULT 'emulation',
  fn_number      text,                            -- номер фискального накопителя
  fd_number      text,                            -- номер фискального документа
  fp             text,                            -- фискальный признак
  ofd_receipt_url text,
  payload        jsonb NOT NULL DEFAULT '{}',
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  registered_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_fiscal_sale ON fiscal_docs(sale_id);
CREATE INDEX IF NOT EXISTS idx_fiscal_status ON fiscal_docs(status);

-- Очередь передачи в ОФД: фоновый воркер повторяет отправку, пока ОФД не подтвердит
-- (чек не теряется при отсутствии интернета). status также может быть 'sending'.
ALTER TABLE fiscal_docs ADD COLUMN IF NOT EXISTS attempts        int NOT NULL DEFAULT 0;
ALTER TABLE fiscal_docs ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE fiscal_docs ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_fiscal_pending ON fiscal_docs(next_attempt_at)
  WHERE status IN ('queued', 'error', 'sending');

-- ---------------------------------------------------------------------------
-- Идемпотентность произвольных офлайн-операций (пункт 3)
-- Для продаж достаточно sales.client_uuid; здесь — прочие операции синхронизации.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_ops (
  client_uuid uuid PRIMARY KEY,
  kind        text NOT NULL,
  result      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Примечания (комментарии) к лидам/заказам в воронке
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id    bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  text       text NOT NULL,
  author     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id);

-- ---------------------------------------------------------------------------
-- Реферальная программа «Приведи друга»
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referred_by   bigint REFERENCES clients(id);
-- Вознаграждён ли пригласивший за первую покупку этого клиента
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_rewarded boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_clients_referred_by ON clients(referred_by);

-- ---------------------------------------------------------------------------
-- СКУД: учёт рабочего времени всего персонала (приход/уход)
-- Отметка — по отпечатку пальца (терминал шлёт fingerprint_id) или вручную.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS personnel (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name      text NOT NULL,
  position       text,                 -- должность: кассир, аниматор, уборщик, повар...
  phone          text,
  fingerprint_id text UNIQUE,          -- идентификатор в терминале отпечатков/карт
  user_id        bigint REFERENCES users(id) ON DELETE SET NULL, -- связь с учёткой панели (если есть)
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_personnel_fp ON personnel(fingerprint_id);

CREATE TABLE IF NOT EXISTS attendance (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  personnel_id bigint NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  direction    text NOT NULL,          -- in | out
  at           timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL DEFAULT 'device', -- device | manual
  device_id    text,
  created_by   bigint REFERENCES users(id)      -- кто внёс, если вручную
);
CREATE INDEX IF NOT EXISTS idx_attendance_person ON attendance(personnel_id, at);
CREATE INDEX IF NOT EXISTS idx_attendance_at ON attendance(at);

-- СКУД: ставка за час у сотрудника + плановый график работы (сетка)
ALTER TABLE personnel ADD COLUMN IF NOT EXISTS hourly_rate numeric(12,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS work_schedule (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  personnel_id  bigint NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  work_date     date NOT NULL,
  planned_hours numeric(6,2) NOT NULL DEFAULT 0,
  note          text,
  UNIQUE (personnel_id, work_date)
);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON work_schedule(work_date);

-- ---------------------------------------------------------------------------
-- Клиентское приложение (личный кабинет): вход по телефону + собственный пароль
-- ---------------------------------------------------------------------------
ALTER TABLE clients ADD COLUMN IF NOT EXISTS pass_hash text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email     text;
-- Быстрый вход по телефону: сравниваем только цифры номера
CREATE INDEX IF NOT EXISTS idx_clients_phone_digits
  ON clients ((regexp_replace(phone, '\D', '', 'g')));

-- ---------------------------------------------------------------------------
-- Новости парка: пишет администратор/владелец в админке, читают клиенты
-- (в приложении «личный кабинет» и на публичном сайте-лендинге).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS news (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  cover       text,                            -- эмодзи-обложка (например 🎉) или URL картинки
  pinned      boolean NOT NULL DEFAULT false,  -- закрепить наверху
  published   boolean NOT NULL DEFAULT true,   -- показывать клиентам
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_feed ON news(published, pinned, created_at DESC);
-- Картинка новости: data-URI (загруженное фото, сжатое на клиенте) или URL
ALTER TABLE news ADD COLUMN IF NOT EXISTS image text;

-- ---------------------------------------------------------------------------
-- Точки продаж (ТЦ). Чайлэнд работает в нескольких ТЦ: клиенты и бонусы —
-- ОБЩИЕ, а касса (смены, продажи, выручка) — РАЗДЕЛЬНАЯ по каждой точке.
-- Точка определяется устройством (каждая касса привязана к своему ТЦ).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,               -- «ТЦ Орбита», «ТЦ Весна» и т.п.
  address    text,
  active     boolean NOT NULL DEFAULT true,
  sort       int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Касса и продажи привязаны к точке (клиенты — НЕТ, они общие).
ALTER TABLE cash_shifts ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES locations(id);
ALTER TABLE sales       ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES locations(id);
-- Каталог может отличаться по ТЦ: location_id IS NULL — товар во всех ТЦ,
-- иначе — только в своей точке.
ALTER TABLE products ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES locations(id);
ALTER TABLE services ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES locations(id);
CREATE INDEX IF NOT EXISTS idx_sales_location ON sales(location_id);
CREATE INDEX IF NOT EXISTS idx_shifts_location ON cash_shifts(location_id);
CREATE INDEX IF NOT EXISTS idx_products_location ON products(location_id);
