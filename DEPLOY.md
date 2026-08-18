# Развёртывание «Чайлэнд» на боевом сервере

Пошаговая инструкция: как поднять админ-панель на реальном сервере с доменом и
автоматическим HTTPS. Всё запускается одной командой через Docker.

## ⭐ Быстрый старт на Timeweb Cloud

Пошагово именно под Timeweb (домен у вас уже есть).

**1. Создать сервер.** В панели `timeweb.cloud` → **Облачные серверы → Создать**:
- Регион: **Россия** (Москва/СПб).
- ОС: **Ubuntu 24.04** (или образ из маркетплейса с уже установленным Docker —
  тогда пропустите шаг 4).
- Конфигурация: **2 × vCPU, 2–4 ГБ RAM, 20+ ГБ NVMe**.
- Публичный **IPv4** — включить.
- Доступ: добавить свой **SSH-ключ** (надёжнее) или задать пароль root.

После создания скопируйте **публичный IP** из карточки сервера.

**2. Направить домен на сервер.** A-запись `admin.<ваш-домен>` → IP сервера:
- если домен делегирован на Timeweb — раздел **«Домены и DNS»**;
- если у другого регистратора — в его панели DNS.

**3. Подключиться по SSH:** `ssh root@<IP сервера>`

**4. Установить Docker** (если не выбрали образ с Docker):
```bash
curl -fsSL https://get.docker.com | sh
```

**5. Развернуть — одной командой (рекомендуется):**
```bash
git clone <URL репозитория> gabrileon-admin && cd gabrileon-admin
sudo DOMAIN=admin.chailand.org bash deploy.sh
```
Скрипт сам поставит Docker, сгенерирует секреты, соберёт и запустит всё и создаст
сотрудников. Всё, что делаете вы, — вставляете эти две строки.

<details><summary>…или вручную, по шагам</summary>

```bash
cp .env.production.example .env
nano .env      # DOMAIN=admin.<ваш-домен>, задать POSTGRES_PASSWORD и JWT_SECRET
#   секреты: openssl rand -hex 48  (JWT_SECRET),  openssl rand -hex 24  (пароль БД)
docker compose up -d --build
docker compose exec app node src/seed.js     # создать сотрудников (один раз)
```
</details>

**6. Открыть** `https://admin.<ваш-домен>`, войти как `owner / owner123` и
**сразу сменить пароли** в разделе «Настройки → Сотрудники».

Подробности, обслуживание и бэкапы — ниже.

---

## ⭐ Быстрый старт на Yandex Cloud

Путь A — одна виртуальная машина Compute Cloud + наш Docker-стек. Изменений в
коде не требует. (Путь B с Managed PostgreSQL — в конце раздела.)

### Шаг 1. Подготовка аккаунта
- Войти в `console.yandex.cloud`, привязать платёжный аккаунт (новым — стартовый грант).
- Обычно уже есть облако и каталог `default` — используем их.

### Шаг 2. Разрешить порты (security group)
**Compute Cloud → Виртуальные машины → (при создании ВМ) → Сетевые настройки →
Группы безопасности.** Создайте группу с **входящими** правилами:

| Протокол | Порт | Источник (CIDR) | Зачем |
|----------|------|-----------------|-------|
| TCP | 22  | ваш IP (или 0.0.0.0/0) | SSH |
| TCP | 80  | 0.0.0.0/0 | HTTP (выпуск сертификата) |
| TCP | 443 | 0.0.0.0/0 | HTTPS (панель) |

И одно **исходящее**: TCP, все порты, `0.0.0.0/0` (для обновлений и Let's Encrypt).

### Шаг 3. Создать ВМ
**Compute Cloud → Создать ВМ:**
- Зона: `ru-central1-a` (любая).
- Образ: **Ubuntu 24.04**.
- vCPU **2**, RAM **2–4 ГБ**, диск **20+ ГБ SSD**.
- Публичный адрес: **свой (статический)** — чтобы IP не менялся при перезапуске
  (Compute Cloud → «IP-адреса» можно зарезервировать заранее).
- Доступ: логин `ubuntu` + ваш **публичный SSH-ключ**.
- Группа безопасности — из шага 2.

Скопируйте **публичный IP** созданной ВМ.

### Шаг 4. Направить домен
A-запись `admin.<ваш-домен>` → публичный IP ВМ (там, где управляется DNS домена).

### Шаг 5. Развернуть
```bash
ssh ubuntu@<IP ВМ>
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && exit      # затем снова: ssh ubuntu@<IP>

git clone <URL репозитория> gabrileon-admin && cd gabrileon-admin
cp .env.production.example .env
nano .env      # DOMAIN=admin.<ваш-домен>, POSTGRES_PASSWORD, JWT_SECRET
#   openssl rand -hex 48  → JWT_SECRET ;  openssl rand -hex 24  → пароль БД
docker compose up -d --build
docker compose exec app node src/seed.js   # создать сотрудников (один раз)
```

### Шаг 6. Открыть
`https://admin.<ваш-домен>` → вход `owner / owner123` → **сразу сменить пароли**.

### Вариант B — Managed Service for PostgreSQL (по желанию)
Яндекс сам делает бэкапы и резервирование БД:
1. **Managed Service for PostgreSQL → Создать кластер**: версия **16**, БД
   `gabrileon`, пользователь `gabrileon`. Хост(ы) — в той же сети, что и ВМ.
2. Скачать сертификат Яндекс CA на ВМ:
   ```bash
   mkdir -p ~/.pg && curl -o ~/.pg/root.crt https://storage.yandexcloud.net/cloud-certs/CA.pem
   ```
3. Использовать `docker-compose.managed-db.yml` (в репозитории) — в нём нет своей
   базы, а `.env` указывает на кластер:
   ```
   DATABASE_URL=postgres://gabrileon:ПАРОЛЬ@<FQDN-хоста>:6432/gabrileon
   DATABASE_CA=/certs/root.crt
   ```
   Запуск: `docker compose -f docker-compose.managed-db.yml up -d --build`.

---

## Что понадобится

1. **VPS/сервер** — Ubuntu 22.04/24.04, минимум **2 vCPU / 2–4 ГБ RAM / 20 ГБ SSD**.
2. **Домен** (например `admin.chailand.org`).

### Где взять (для РФ, данные остаются в России — 152-ФЗ)

- **Сервер**: Timeweb Cloud, Selectel, VK Cloud, Yandex Cloud, Reg.ru Cloud.
- **Домен**: reg.ru, timeweb, nic.ru.

> Мне не нужно (и я не могу) заходить в ваши аккаунты и оплачивать — сервер и
> домен регистрируете вы. Ниже — что делать после того, как они у вас есть.

## Шаг 1. Направить домен на сервер

В панели регистратора домена создайте **A-запись**:

```
admin.chailand.org.   A   <IP вашего сервера>
```

Подождите, пока запись обновится (обычно минуты, максимум пара часов). Проверить:
`ping admin.chailand.org` должен отвечать с IP сервера.

## Шаг 2. Установить Docker на сервере

Подключитесь по SSH и выполните:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # чтобы docker работал без sudo (перезайдите по SSH)
```

## Шаг 3. Забрать код и настроить

```bash
git clone <URL этого репозитория> gabrileon-admin
cd gabrileon-admin

cp .env.production.example .env
nano .env        # заполнить DOMAIN, POSTGRES_PASSWORD, JWT_SECRET
```

Сгенерировать надёжные секреты:

```bash
openssl rand -hex 48      # вставить в JWT_SECRET
openssl rand -hex 24      # вставить в POSTGRES_PASSWORD
```

## Шаг 4. Запустить

```bash
docker compose up -d --build
```

Что произойдёт автоматически:
- поднимется PostgreSQL (данные — в постоянном томе `pgdata`);
- приложение применит схему БД (`AUTO_MIGRATE=1`);
- Caddy получит HTTPS-сертификат Let's Encrypt для вашего домена.

## Шаг 5. Создать сотрудников (один раз)

```bash
docker compose exec app node src/seed.js
```

Появятся демо-логины `owner / admin / cashier` (пароли `*123`).
**Сразу же смените пароли** — войдите как `owner`, раздел «Настройки → Сотрудники»,
либо задайте новых и удалите демо-учётки.

> Не запускайте `seed:history` на боевом сервере — это демонстрационные продажи.

## Шаг 6. Открыть панель

`https://admin.chailand.org` — вход по логину и паролю. Готово.

---

## Если Docker Hub / npm недоступны (частое на серверах в РФ)

Из части дата-центров заблокированы `get.docker.com`, Docker Hub и иногда
`npmjs.org`. Признаки: `TLS handshake timeout` при скачивании образов или
`npm error Exit handler never called!` при сборке.

- **Docker** ставьте из репозитория Ubuntu (надёжно, с зеркала провайдера):
  ```bash
  apt update && apt install -y docker.io docker-compose-v2 docker-buildx
  systemctl enable --now docker
  ```
- **Зеркало реестра образов** (`deploy.sh` делает это сам; вручную — так):
  ```bash
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
  { "registry-mirrors": ["https://mirror.gcr.io", "https://huecker.io", "https://docker.m.daocloud.io"] }
  EOF
  systemctl restart docker
  ```
- **npm** уже берётся с зеркала в `Dockerfile`. Если нужно вернуть npmjs:
  `docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org`

Если конкретное зеркало не отвечает — замените список в `daemon.json` на рабочее
и `systemctl restart docker`.

## Обслуживание

**Обновить до новой версии:**
```bash
git pull
docker compose up -d --build
```

### Резервные копии (бэкапы)

**Автоматически (уже включено).** Сервис `backup` в `docker-compose.yml`
каждые 5 минут (настраивается `BACKUP_INTERVAL` в `.env`) снимает сжатую
копию базы в папку `./backups`:
- `./backups/recent/` — последние копии (по умолчанию за ~сутки);
- `./backups/daily/` — по одной копии на день (по умолчанию 30 дней).

Данные пишутся в БД мгновенно при каждом действии (это свойство PostgreSQL) —
автобэкап это **вторая копия** на случай потери диска. Ничего запускать вручную
не нужно, копии появляются сами. Проверить, что работает:
```bash
docker compose logs -f backup     # видно строки «[backup] ✓ …»
ls -lh backups/recent | tail
```

> ⚠️ Локальные бэкапы погибнут вместе с диском. Настройте выгрузку в облако
> (ниже) — это последняя линия защиты.

**Выгрузка бэкапов в облако (Яндекс.Диск).** Копия базы будет автоматически
улетать в ваш Яндекс.Диск (по умолчанию раз в час):
1. Откройте `id.yandex.ru` → «Безопасность» → «Пароли приложений» → создайте
   пароль с типом **WebDAV** (это отдельный пароль, не основной).
2. В `.env` на сервере заполните и включите:
   ```
   CLOUD_UPLOAD=yadisk
   YADISK_USER=ваш_логин        # без @yandex.ru
   YADISK_PASS=пароль_приложения
   ```
3. Перезапустите бэкап: `docker compose up -d backup`
4. Проверьте: `docker compose logs -f backup` → строки `☁ выгружено…`. В
   Яндекс.Диске появится папка `gabrileon-backups` с файлами `gab-ДАТА.sql.gz`.

**Ручной бэкап одной командой:**
```bash
./scripts/backup.sh          # → backups/gab-manual-ДАТА.sql.gz
```

**Восстановление из копии** (заменяет текущие данные — спросит подтверждение):
```bash
./scripts/restore.sh backups/daily/gab-ГГГГММДД.sql.gz
```

> ⛔ Никогда не используйте `docker compose down -v` и `docker volume rm` —
> флаг `-v` и эти команды **удаляют базу**. Для остановки только
> `docker compose down` (без `-v`).

**Логи / статус:**
```bash
docker compose ps
docker compose logs -f app
```

**Остановить / запустить:**
```bash
docker compose down      # остановить (данные сохранятся в томах)
docker compose up -d     # запустить снова
```

---

## Публичный сайт chailand.org

На том же сервере, рядом с админкой, отдаётся публичный сайт-лендинг парка
(репозиторий `gabrileon`). Caddy маршрутизирует по имени хоста:

| Адрес                     | Что открывается                        |
| ------------------------- | -------------------------------------- |
| `chailand.org`            | статический сайт-лендинг (репо `gabrileon`) |
| `chailand.org/lk`         | клиентское приложение «личный кабинет» (PWA) |
| `lk.chailand.org`         | короткий адрес → редирект на `/lk`     |
| `www.chailand.org`        | редирект на `chailand.org`             |
| `admin.chailand.org`      | админ-панель / касса (это приложение)  |

**Личный кабинет клиента** (`chailand.org/lk`) — PWA: карта с QR, бонусы,
«приведи друга», заявка на праздник (падает прямо в воронку) и профиль с
детьми. Вход/регистрация — по телефону и собственному паролю (SMS не нужен).
Приложение отдаёт сам сервер (папка `client/`), API — `/api/client/*`.
Отдельных шагов деплоя нет: обычный `docker compose up -d --build`. Новая
миграция добавляет клиенту поля `pass_hash`/`email` (применяется автоматически
при `AUTO_MIGRATE=1` или командой `docker compose exec app node src/migrate.js`).
Чтобы короткий адрес `lk.chailand.org` работал — добавьте в Cloudflare запись
`CNAME` · имя `lk` → `chailand.org` (оранжевое облако, как у остальных).

Файлы сайта лежат прямо в этом репозитории (папка `site/`), поэтому на сервере
не нужен отдельный репозиторий или второй токен — достаточно `git pull`.
Caddy монтирует `site/` как `/srv/site` (путь задаётся `SITE_ROOT` в `.env`,
по умолчанию `./site`).

**Шаг 1. DNS в Cloudflare.** В той же зоне, где уже есть `admin`, добавьте
записи (обе — с оранжевым облаком «Proxied», SSL-режим оставляем **Flexible**):

- `A` · имя `@` (корень) → IP сервера aeza (тот же, что у `admin`)
- `CNAME` · имя `www` → `chailand.org`

**Шаг 2. Обновить и перезапустить на сервере:**
```bash
cd ~/gabrileon-admin
git pull
docker compose up -d
```
Затем в Cloudflare → **Caching → Purge Everything**.

**Обновление сайта.** Источник вёрстки — репозиторий `gabrileon`. Когда там
что-то меняется, синхронизируйте копию в `site/` этого репозитория (скопируйте
изменённые файлы, закоммитьте, запушьте), затем на сервере `git pull`.
Перезапускать контейнеры не нужно — Caddy отдаёт файлы напрямую; достаточно
сбросить кэш Cloudflare.

---

## Что включаем после боевого запуска

Код к этому готов, активируется на живом сервере с доменом:

- **Фискализация (54-ФЗ) через ОФД Такском** — драйвер `taxcom` (облачная касса
  Такском Ferma) уже встроен в `server/src/services/fiscal.js`. После договора с
  Такском впишите реквизиты в настройки (`taxcom_ferma_url`, `taxcom_login`,
  `taxcom_password`, `taxcom_inn`) и переключите `fiscal_driver` на `taxcom`.
  Работает офлайн-устойчиво: каждый чек кладётся в очередь `fiscal_docs` и
  фоновый воркер повторяет отправку в ОФД, пока налоговая не подтвердит, —
  чек не теряется при обрыве интернета. До подключения активна эмуляция.
- **Эквайринг** — договор с банком + POS-терминал (Сбербанк/ВТБ). Драйвер —
  `server/src/services/acquiring.js`.
- **Push-уведомления** клиентам (дни рождения, акции) — теперь возможны, т.к.
  есть HTTPS-домен (для web-push это обязательное условие).
- **Автобэкапы** БД по расписанию (cron + pg_dump в облачное хранилище).

## Безопасность (уже включено)

- HTTPS с автообновлением сертификата (Caddy).
- Заголовки безопасности (helmet), сжатие ответов.
- Ограничение попыток входа (защита от подбора пароля).
- Пароли — bcrypt, доступ — JWT, права по ролям.
- База не открыта наружу (только внутренняя сеть Docker).
