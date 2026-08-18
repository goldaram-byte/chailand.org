#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Автоматическая установка админ-панели «Чайлэнд» на чистый сервер Ubuntu.
# Ставит Docker, генерирует секреты, собирает и запускает всё, создаёт сотрудников.
#
# Запуск на сервере (из папки с проектом):
#   sudo DOMAIN=admin.chailand.org bash deploy.sh
# Если DOMAIN не задан — скрипт спросит его интерактивно.
# ---------------------------------------------------------------------------
set -euo pipefail

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"

# --- 0. Домен -------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
if [ -z "$DOMAIN" ]; then
  read -rp "Домен для панели (например admin.chailand.org): " DOMAIN
fi
[ -n "$DOMAIN" ] || die "Домен обязателен."

# --- 1. Docker ------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Устанавливаю Docker…"
  # get.docker.com в части ДЦ РФ недоступен — ограничиваем ожидание и падаем на apt
  if curl -fsSL --max-time 30 https://get.docker.com -o /tmp/get-docker.sh 2>/dev/null && sh /tmp/get-docker.sh; then
    ok "Docker установлен (get.docker.com)"
  else
    warn "get.docker.com недоступен — ставлю Docker из репозитория Ubuntu…"
    apt-get update && apt-get install -y docker.io docker-compose-v2 docker-buildx
    systemctl enable --now docker 2>/dev/null || true
    ok "Docker установлен (apt)"
  fi
else
  ok "Docker уже установлен"
fi
docker compose version >/dev/null 2>&1 || die "Нужен Docker Compose v2. Установите: apt-get install -y docker-compose-v2"

# --- 1a. Зеркало реестра Docker (Docker Hub из части ДЦ в РФ недоступен) ---
if [ ! -f /etc/docker/daemon.json ]; then
  say "Настраиваю зеркало реестра Docker (Docker Hub бывает недоступен)…"
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": ["https://mirror.gcr.io", "https://huecker.io", "https://docker.m.daocloud.io"]
}
EOF
  systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true
  sleep 3
  ok "Зеркало реестра настроено"
else
  ok "Конфиг Docker уже есть (/etc/docker/daemon.json) — не трогаю"
fi

# --- 2. .env (секреты генерируются автоматически) -------------------------
if [ -f .env ]; then
  ok ".env уже существует — оставляю без изменений"
  # Проставим DOMAIN, если его там нет
  grep -q '^DOMAIN=' .env || echo "DOMAIN=$DOMAIN" >> .env
else
  say "Генерирую секреты и создаю .env…"
  gen() { openssl rand -hex "$1" 2>/dev/null || head -c "$(( $1 * 2 ))" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  JWT_SECRET="$(gen 48)"
  POSTGRES_PASSWORD="$(gen 24)"
  cat > .env <<EOF
DOMAIN=$DOMAIN
POSTGRES_USER=gabrileon
POSTGRES_DB=gabrileon
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
JWT_TTL=12h
EOF
  chmod 600 .env
  ok ".env создан (секреты сгенерированы автоматически)"
fi

# --- 3. Сборка и запуск ---------------------------------------------------
say "Собираю и запускаю контейнеры…"
docker compose up -d --build
ok "Контейнеры запущены"

# --- 4. Ожидание готовности приложения ------------------------------------
say "Жду готовности приложения…"
for i in $(seq 1 40); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ok "Приложение отвечает"
    break
  fi
  sleep 3
  [ "$i" = 40 ] && warn "Приложение долго не отвечает — проверьте: docker compose logs -f app"
done

# --- 5. Первичные сотрудники (идемпотентно) -------------------------------
say "Создаю учётные записи сотрудников (если их ещё нет)…"
docker compose exec -T app node src/seed.js || warn "seed завершился с ошибкой — можно повторить вручную: docker compose exec app node src/seed.js"

# --- 6. Итог --------------------------------------------------------------
cat <<EOF

$(ok "Готово!")

  Панель:   https://$DOMAIN
  Вход:     owner / owner123   (СРАЗУ смените пароли: Настройки → Сотрудники)

  Осталось одно, если ещё не сделали:
  • A-запись  $DOMAIN → IP этого сервера (в reg.ru).
    HTTPS-сертификат выпустится автоматически, как только домен заработает.

  Полезное:
    docker compose logs -f app        # логи
    docker compose ps                 # статус
    docker compose exec db pg_dump -U gabrileon gabrileon > backup_\$(date +%F).sql   # бэкап

EOF
