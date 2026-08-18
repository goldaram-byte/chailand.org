import pg from 'pg';
import { readFileSync } from 'node:fs';
import { env } from './env.js';

const { Pool } = pg;

// SSL к управляемой БД (например Yandex Managed PostgreSQL): путь к CA в DATABASE_CA.
// Без переменной — обычное подключение (локально/в Docker-сети).
let ssl;
if (process.env.DATABASE_CA) {
  ssl = { ca: readFileSync(process.env.DATABASE_CA).toString(), rejectUnauthorized: true };
} else if (process.env.DATABASE_SSL === 'require') {
  ssl = { rejectUnauthorized: false };
}

// Возвращаем деньги как number, а bigint как number (у нас нет значений > 2^53)
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8
pg.types.setTypeParser(1082, (v) => v); // date -> оставляем строкой 'YYYY-MM-DD', без часового пояса

export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] неожиданная ошибка пула соединений:', err.message);
});

/**
 * Выполнить запрос. Возвращает массив строк (rows).
 * @param {string} sql
 * @param {any[]} [params]
 */
export async function q(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

/** Выполнить запрос и вернуть первую строку или null. */
export async function q1(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

/**
 * Выполнить набор запросов в транзакции.
 * fn получает объект с методами q/q1, работающими на выделенном клиенте.
 * @param {(c:{q:Function,q1:Function,client:import('pg').PoolClient})=>Promise<any>} fn
 */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cq = async (sql, params = []) => (await client.query(sql, params)).rows;
    const cq1 = async (sql, params = []) => (await cq(sql, params))[0] ?? null;
    const result = await fn({ q: cq, q1: cq1, client });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function ping() {
  const row = await q1('select version() as v');
  return row?.v;
}
