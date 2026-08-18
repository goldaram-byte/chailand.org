// Смена пароля сотрудника из командной строки.
//   docker compose exec app node src/set-password.js <логин> <новый_пароль>
import { pool, q } from './db.js';
import { hashPassword } from './auth.js';

const login = process.argv[2];
const password = process.argv[3];

if (!login || !password) {
  console.error('Использование: node src/set-password.js <логин> <новый_пароль>');
  process.exit(1);
}

const rows = await q(
  'UPDATE users SET pass_hash = $1, updated_at = now() WHERE lower(login) = lower($2) RETURNING login, role_code',
  [hashPassword(password), login]
);

if (rows.length) {
  console.log(`✓ Пароль изменён: ${rows[0].login} (${rows[0].role_code})`);
} else {
  console.log(`✗ Пользователь не найден: ${login}`);
}

await pool.end();
process.exit(0);
