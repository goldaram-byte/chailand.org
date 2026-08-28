import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { env } from './env.js';
import { ping, pool } from './db.js';
import { migrate } from './migrate.js';
import { authRouter } from './routes/auth.js';
import { catalogRouter } from './routes/catalog.js';
import { posRouter } from './routes/pos.js';
import { clientsRouter } from './routes/clients.js';
import { crmRouter } from './routes/crm.js';
import { bookingsRouter } from './routes/bookings.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { usersRouter } from './routes/users.js';
import { syncRouter } from './routes/sync.js';
import { publicRouter } from './routes/public.js';
import { skudRouter } from './routes/skud.js';
import { clientAppRouter } from './routes/client.js';
import { newsRouter } from './routes/news.js';
import { locationsRouter } from './routes/locations.js';
import { passesRouter } from './routes/passes.js';
import { chatRouter } from './routes/chat.js';
import { startFiscalWorker } from './services/fiscal.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1);
// Заголовки безопасности. CSP отключаем: панель — единый HTML со встроенными
// скриптами (одобренный интерфейс), строгий CSP его сломает.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(express.json({ limit: '8mb' })); // до 8 МБ — под картинки новостей (data-URI)
app.use(cookieParser());

// Ограничение попыток входа (защита от подбора пароля)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Повторите позже.' },
});

// Простой CORS (для отдельного фронта; при same-origin список пуст)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && env.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.get('/api/health', async (req, res) => {
  try {
    const v = await ping();
    res.json({ ok: true, db: v ? 'up' : 'down' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API
// Публичные ручки для сайта (без авторизации) — до всех защищённых роутов.
app.use('/api/public', publicRouter);
// Клиентское приложение «личный кабинет» (своя авторизация: телефон + пароль).
app.use('/api/client', clientAppRouter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/pos', posRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/crm', crmRouter);
app.use('/api/skud', skudRouter);
app.use('/api/news', newsRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/passes', passesRouter);
app.use('/api/chat', chatRouter);
app.use('/api/bookings', bookingsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/users', usersRouter);
app.use('/api/sync', syncRouter);

// Статика: демо-панель (index.html лежит в корне репозитория, на уровень выше server/)
const webRoot = resolve(__dirname, '..', '..');
// Клиентское приложение (личный кабинет) — отдельный PWA под /lk
app.use('/lk', express.static(resolve(webRoot, 'client'), { index: 'index.html', extensions: ['html'] }));
app.use(express.static(webRoot, { index: 'index.html', extensions: ['html'] }));

// Обработчик ошибок
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api]', err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка' });
});

export async function start() {
  // В контейнере удобно применять схему на старте (AUTO_MIGRATE=1)
  if (process.env.AUTO_MIGRATE === '1') {
    try { await migrate(); } catch (e) { console.error('[start] миграция не удалась:', e.message); }
  }
  const server = app.listen(env.port, () => {
    console.log(`[gabrileon-admin] сервер запущен на порту ${env.port} (${env.nodeEnv})`);
  });
  // Фоновая передача чеков в ОФД: разбирает очередь fiscal_docs и повторяет
  // отправку, пока ОФД не подтвердит (устойчивость к обрыву интернета).
  startFiscalWorker(30000);
  const shutdown = (sig) => {
    console.log(`[gabrileon-admin] получен ${sig}, останавливаюсь...`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { app };
