#!/bin/sh
# Восстановление базы «Габрилеон» из бэкапа.
#   ./scripts/restore.sh backups/daily/gab-20260719.sql.gz
#
# ВНИМАНИЕ: заменяет текущие данные данными из бэкапа. Сначала сделайте
# свежий бэкап (./scripts/backup.sh), если хотите сохранить текущее состояние.
set -e
cd "$(dirname "$0")/.."

F="${1:?Укажите файл бэкапа: ./scripts/restore.sh <файл.sql.gz>}"
[ -f "$F" ] || { echo "Файл не найден: $F"; exit 1; }

DBUSER="${POSTGRES_USER:-gabrileon}"
DBNAME="${POSTGRES_DB:-gabrileon}"

printf 'Восстановить базу из "%s"? Текущие данные будут заменены. [y/N] ' "$F"
read ans
case "$ans" in
  y|Y|yes|Yes|да|Да) ;;
  *) echo "Отменено."; exit 0 ;;
esac

echo "Восстанавливаю..."
gunzip -c "$F" | docker compose exec -T db psql -U "$DBUSER" -d "$DBNAME"
echo "Готово. Перезапустите приложение при необходимости: docker compose restart app"
