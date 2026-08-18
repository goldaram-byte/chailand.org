// Новости парка. Управление — из админки (право 'news'): создать, изменить,
// опубликовать/снять, закрепить, удалить. Чтение опубликованных новостей —
// публично (см. routes/public.js: GET /api/public/news) для приложения и сайта.
import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const newsRouter = Router();
newsRouter.use(requireAuth, requirePerm('news'));

// Список всех новостей (включая черновики) — для админки
newsRouter.get(
  '/',
  ah(async (req, res) => {
    res.json(await q('SELECT * FROM news ORDER BY pinned DESC, created_at DESC'));
  })
);

// Ограничение на размер картинки (data-URI). Клиент сжимает перед отправкой.
const MAX_IMAGE = 6 * 1024 * 1024;

newsRouter.post(
  '/',
  ah(async (req, res) => {
    const { title, body, cover, image, pinned = false, published = true } = req.body || {};
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'Укажите заголовок новости' });
    if (image && String(image).length > MAX_IMAGE) return res.status(400).json({ error: 'Слишком большая картинка' });
    const row = await q1(
      `INSERT INTO news (title, body, cover, image, pinned, published)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(title).trim(), String(body || ''), cover ? String(cover).slice(0, 300) : null, image ? String(image) : null, !!pinned, !!published]
    );
    await audit(req, 'news.create', { entity: 'news', entityId: row.id });
    res.json(row);
  })
);

newsRouter.put(
  '/:id',
  ah(async (req, res) => {
    const b = req.body || {};
    const { title, body, cover, pinned, published } = b;
    // Картинку меняем только если поле передано (пустая строка/null — убрать).
    const imageProvided = Object.prototype.hasOwnProperty.call(b, 'image');
    const image = imageProvided ? (b.image ? String(b.image) : null) : null;
    if (image && image.length > MAX_IMAGE) return res.status(400).json({ error: 'Слишком большая картинка' });
    const row = await q1(
      `UPDATE news SET
         title     = COALESCE(NULLIF(trim($2),''), title),
         body      = COALESCE($3, body),
         cover     = COALESCE($4, cover),
         image     = CASE WHEN $5::bool THEN $6 ELSE image END,
         pinned    = COALESCE($7, pinned),
         published = COALESCE($8, published),
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        title == null ? null : String(title),
        body == null ? null : String(body),
        cover == null ? null : String(cover).slice(0, 300),
        imageProvided,
        image,
        pinned == null ? null : !!pinned,
        published == null ? null : !!published,
      ]
    );
    if (!row) return res.status(404).json({ error: 'Новость не найдена' });
    res.json(row);
  })
);

newsRouter.delete(
  '/:id',
  ah(async (req, res) => {
    await q('DELETE FROM news WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  })
);
