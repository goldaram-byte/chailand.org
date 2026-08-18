# Боевой образ админ-панели «Габрилеон» (API + статика панели)
FROM node:22-alpine

WORKDIR /app/server

# Зависимости (используем только production).
# Реестр по умолчанию npmjs.org из части дата-центров РФ недоступен/тормозит,
# поэтому берём с зеркала и увеличиваем таймауты/повторы. Пакеты и хеши те же,
# integrity-проверка package-lock проходит. Реестр можно переопределить сборкой:
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY server/package*.json ./
RUN npm config set registry "$NPM_REGISTRY" \
 && npm config set fetch-timeout 600000 \
 && npm config set fetch-retries 5 \
 && npm config set fetch-retry-maxtimeout 600000 \
 && npm ci --omit=dev

# Код сервера
COPY server ./

# Статика панели (index.html и app.js лежат в корне репозитория; сервер отдаёт
# их из webRoot = на два уровня выше src/, то есть из /app)
COPY index.html /app/index.html
COPY app.js /app/app.js
COPY logo.png /app/logo.png
# Клиентское приложение «личный кабинет» (PWA) — отдаётся из /app/client под /lk
COPY client /app/client

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

# Проверка здоровья контейнера
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
