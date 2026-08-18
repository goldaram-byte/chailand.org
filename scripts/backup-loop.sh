#!/bin/sh
# Автоматический бэкап базы «Габрилеон».
# Работает в отдельном контейнере (сервис backup в docker-compose): каждые
# BACKUP_INTERVAL секунд снимает сжатую копию базы в папку ./backups на сервере.
# Данные пишутся в БД мгновенно при каждом действии — это ВТОРАЯ копия на случай
# потери диска. Копии удобно скачивать/выгружать наружу (папка ./backups).

INTERVAL="${BACKUP_INTERVAL:-300}"          # период между копиями, сек (5 мин)
DBUSER="${POSTGRES_USER:-gabrileon}"
DBNAME="${POSTGRES_DB:-gabrileon}"
RECENT_KEEP="${BACKUP_RECENT_KEEP:-288}"    # сколько последних копий хранить (288×5мин ≈ 24ч)
DAILY_KEEP="${BACKUP_DAILY_KEEP:-30}"       # сколько суточных копий хранить (дней)

# --- Выгрузка в облако (необязательно). Пока поддержан Яндекс.Диск (WebDAV) ---
CLOUD_UPLOAD="${CLOUD_UPLOAD:-}"            # yadisk — включить; пусто — выключено
YADISK_USER="${YADISK_USER:-}"             # логин на Яндексе (без @yandex.ru)
YADISK_PASS="${YADISK_PASS:-}"             # пароль приложения (id.yandex.ru → Пароли приложений)
YADISK_DIR="${YADISK_DIR:-gabrileon-backups}"
UPLOAD_EVERY="${UPLOAD_INTERVAL:-3600}"    # как часто выгружать, сек (3600 = раз в час)

mkdir -p /backups/recent /backups/daily
echo "[backup] старт: копия каждые ${INTERVAL}с, база=${DBNAME}, хранить ${RECENT_KEEP} последних + ${DAILY_KEEP} суточных"

# Подготовка облачной выгрузки: ставим curl (если нужно) и создаём папку на Диске
upload_ready=0
if [ "$CLOUD_UPLOAD" = "yadisk" ] && [ -n "$YADISK_USER" ] && [ -n "$YADISK_PASS" ]; then
  if command -v curl >/dev/null 2>&1 || apk add --no-cache curl ca-certificates >/dev/null 2>&1; then
    curl -s -u "$YADISK_USER:$YADISK_PASS" -X MKCOL "https://webdav.yandex.ru/$YADISK_DIR/" >/dev/null 2>&1 || true
    upload_ready=1
    echo "[backup] ☁ выгрузка в Яндекс.Диск включена → папка /$YADISK_DIR (раз в ${UPLOAD_EVERY}с)"
  else
    echo "[backup] ☁ curl недоступен — облачная выгрузка выключена (локальные копии работают)"
  fi
fi
upload_cycles=$(( UPLOAD_EVERY / INTERVAL )); [ "$upload_cycles" -lt 1 ] && upload_cycles=1
cycle=0

while true; do
  ts=$(date +%Y%m%d-%H%M%S)
  day=$(date +%Y%m%d)
  tmp="/backups/recent/.gab-${ts}.sql.gz.tmp"
  out="/backups/recent/gab-${ts}.sql.gz"
  # -h db — подключение к сервису базы; пароль берётся из PGPASSWORD.
  if pg_dump -h db -U "$DBUSER" "$DBNAME" 2>/tmp/bkerr | gzip > "$tmp"; then
    mv "$tmp" "$out"
    # Суточный срез (одна копия на день) для длинной истории
    cp "$out" "/backups/daily/gab-${day}.sql.gz"
    # Чистка: оставляем только последние N файлов (без xargs — переносимо для busybox)
    ls -1t /backups/recent/gab-*.sql.gz 2>/dev/null | tail -n +$((RECENT_KEEP + 1)) | while read -r f; do rm -f "$f"; done
    ls -1t /backups/daily/gab-*.sql.gz  2>/dev/null | tail -n +$((DAILY_KEEP + 1))  | while read -r f; do rm -f "$f"; done
    echo "[backup] ✓ ${out} ($(date '+%H:%M:%S'))"

    # Выгрузка в облако раз в UPLOAD_EVERY (грузим суточный срез; за день
    # перезаписывается один файл gab-ДАТА.sql.gz, обновляясь по расписанию).
    cycle=$((cycle + 1))
    if [ "$upload_ready" = 1 ] && [ $((cycle % upload_cycles)) -eq 0 ]; then
      remote="https://webdav.yandex.ru/$YADISK_DIR/gab-${day}.sql.gz"
      if curl -s -f -u "$YADISK_USER:$YADISK_PASS" -T "/backups/daily/gab-${day}.sql.gz" "$remote" >/dev/null 2>&1; then
        echo "[backup] ☁ выгружено в Яндекс.Диск: gab-${day}.sql.gz"
      else
        echo "[backup] ☁ не удалось выгрузить в Яндекс.Диск (проверьте логин и пароль приложения)"
      fi
    fi
  else
    rm -f "$tmp"
    echo "[backup] ✗ ОШИБКА pg_dump: $(cat /tmp/bkerr 2>/dev/null) ($(date '+%H:%M:%S'))"
  fi
  sleep "$INTERVAL"
done
