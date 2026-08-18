import { Router } from 'express';
import { q, q1 } from '../db.js';
import { requireAuth, requirePerm } from '../auth.js';
import { ah, audit } from '../util.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// GET /api/settings — общие настройки (доступно всем авторизованным для чтения кэшбэка и т.п.)
settingsRouter.get(
  '/',
  ah(async (req, res) => {
    const rows = await q('SELECT key, value FROM settings');
    const out = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  })
);

// PUT /api/settings { key: value, ... }
settingsRouter.put(
  '/',
  requirePerm('settings'),
  ah(async (req, res) => {
    const body = req.body || {};
    for (const [k, v] of Object.entries(body)) {
      await q(
        `INSERT INTO settings (key, value) VALUES ($1,$2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, JSON.stringify(v)]
      );
    }
    await audit(req, 'settings.update', { meta: { keys: Object.keys(body) } });
    res.json({ ok: true });
  })
);

// GET /api/settings/acquiring
settingsRouter.get(
  '/acquiring',
  requirePerm('acquiring'),
  ah(async (req, res) => {
    const row = await q1('SELECT * FROM acquiring_config WHERE id=1');
    res.json(row);
  })
);

// PUT /api/settings/acquiring
settingsRouter.put(
  '/acquiring',
  requirePerm('acquiring'),
  ah(async (req, res) => {
    const { bank, terminal_id, merchant_id, mode, connected, extra } = req.body || {};
    const row = await q1(
      `UPDATE acquiring_config SET
         bank=COALESCE($1,bank), terminal_id=COALESCE($2,terminal_id), merchant_id=COALESCE($3,merchant_id),
         mode=COALESCE($4,mode), connected=COALESCE($5,connected), extra=COALESCE($6,extra), updated_at=now()
       WHERE id=1 RETURNING *`,
      [bank, terminal_id, merchant_id, mode, connected, extra ? JSON.stringify(extra) : null]
    );
    await audit(req, 'acquiring.update', { meta: { bank: row.bank, mode: row.mode, connected: row.connected } });
    res.json(row);
  })
);

// POST /api/settings/acquiring/test — проверка подключения терминала (эмуляция)
settingsRouter.post(
  '/acquiring/test',
  requirePerm('acquiring'),
  ah(async (req, res) => {
    const cfg = await q1('SELECT * FROM acquiring_config WHERE id=1');
    if (cfg.mode === 'emulation') {
      return res.json({ ok: true, message: 'Режим эмуляции: терминал отвечает (демо).' });
    }
    // Реальная проверка появится вместе с драйвером банка
    res.json({ ok: false, message: `Драйвер банка «${cfg.bank}» ещё не активирован — подключим после договора и терминала.` });
  })
);
