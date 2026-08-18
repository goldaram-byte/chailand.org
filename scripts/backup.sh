#!/bin/sh
# Ручной бэкап базы «Габрилеон» одной командой.
#   ./scripts/backup.sh
# Копия сохраняется в ./backups/gab-manual-ДАТА-ВРЕМЯ.sql.gz
set -e
cd "$(dirname "$0")/.."

DBUSER="${POSTGRES_USER:-gabrileon}"
DBNAME="${POSTGRES_DB:-gabrileon}"
mkdir -p backups
OUT="backups/gab-manual-$(date +%Y%m%d-%H%M%S).sql.gz"

docker compose exec -T db pg_dump -U "$DBUSER" "$DBNAME" | gzip > "$OUT"
echo "Бэкап сохранён: $OUT"
ls -lh "$OUT"
