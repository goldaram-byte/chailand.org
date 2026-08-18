import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { pool } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[migrate] схема применена');
}

// Запуск напрямую: node src/migrate.js
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] ошибка:', err.message);
      process.exit(1);
    });
}
