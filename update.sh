#!/bin/sh
# Обновление «Чайлэнд» на сервере ОДНОЙ командой:
#   ./update.sh
# Забирает свежий код, пересобирает, перезапускает и применяет миграции.
# Данные (база в томе pgdata) при этом НЕ трогаются.
set -e
cd "$(dirname "$0")"
BRANCH=main

echo "==> 1/5 Забираю свежий код ($BRANCH)..."
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

echo "==> 2/5 Пересобираю образ и перезапускаю контейнеры..."
docker compose up -d --build

echo "==> 3/5 Перезапускаю Caddy (маршруты сайта и приложения /lk)..."
docker compose restart caddy

echo "==> 4/5 Применяю миграции базы..."
sleep 4
docker compose exec -T app node src/migrate.js || echo "   (миграции применятся автоматически при старте app)"

echo "==> 5/5 Готово. Версия на сервере:"
git log --oneline -1
echo ""
echo "Не забудьте сбросить кэш Cloudflare (Caching -> Purge Everything)."
