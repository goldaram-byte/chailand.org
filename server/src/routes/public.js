import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { q, q1 } from '../db.js';
import { ah } from '../util.js';

// Публичные (без авторизации) ручки для сайта-лендинга gabrileon.ru.
// Заявки с сайта падают напрямую в воронку продаж (таблица leads, статус «new»).
export const publicRouter = Router();

// Анти-спам: не больше 20 заявок с одного IP за 10 минут.
const leadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много заявок. Попробуйте позже или позвоните нам.' },
});

const str = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max);

// POST /api/public/leads — заявка с сайта → воронка
publicRouter.post(
  '/leads',
  leadLimiter,
  ah(async (req, res) => {
    const b = req.body || {};
    // Honeypot: скрытое поле, которое заполняют только боты — тихо игнорируем.
    if (str(b.company, 100)) return res.json({ ok: true });

    const phone = str(b.phone, 40);
    const name = str(b.name, 120) || 'Заявка с сайта';
    const source = str(b.source, 60) || 'Сайт';
    const note = str(b.note, 2000) || null;

    if (!phone) return res.status(400).json({ error: 'Укажите телефон для связи' });

    const lead = await q1(
      `INSERT INTO leads (name, phone, source, status, note)
       VALUES ($1,$2,$3,'new',$4) RETURNING id`,
      [name, phone, source, note]
    );
    res.json({ ok: true, id: lead.id });
  })
);

// GET /api/public/news — опубликованные новости парка (для сайта и приложения)
publicRouter.get(
  '/news',
  ah(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 50);
    const rows = await q(
      `SELECT id, title, body, cover, image, pinned, created_at FROM news
        WHERE published = true
        ORDER BY pinned DESC, created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(rows);
  })
);
