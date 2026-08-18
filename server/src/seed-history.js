// Генерация исторических продаж (~55 дней) для наполнения дашборда живыми данными.
// Идемпотентно: помечает свои строки comment='__seed_history__' и пересоздаёт их.
import { pool, q, q1, tx } from './db.js';

const DAYS = 55;
const MARK = '__seed_history__';

function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shiftDate(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }

export async function seedHistory() {
  const products = await q(`SELECT id, name, price, group_id FROM products WHERE price > 0`);
  const cashiers = await q(`SELECT id FROM users`);
  if (!products.length || !cashiers.length) {
    console.log('[seed-history] нет каталога/пользователей — сначала npm run seed');
    return;
  }
  const byGroup = {};
  for (const p of products) (byGroup[p.group_id] = byGroup[p.group_id] || []).push(p);
  const groupIds = Object.keys(byGroup).map(Number);
  const cashierIds = cashiers.map((c) => c.id);

  // Удалить прошлые сгенерированные строки
  await q(`DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE comment = $1)`, [MARK]);
  await q(`DELETE FROM sales WHERE comment = $1`, [MARK]);

  const groupPick = () => { const r = Math.random(); return r < 0.55 ? groupIds[0] : (r < 0.85 ? (groupIds[1] || groupIds[0]) : (groupIds[2] || groupIds[0])); };
  const methodPick = () => { const r = Math.random(); return r < 0.45 ? 'cash' : (r < 0.85 ? 'card' : 'online'); };

  const today = new Date();
  let total = 0;

  await tx(async ({ q: cq }) => {
    for (let d = DAYS - 1; d >= 0; d--) {
      const day = shiftDate(today, -d);
      const dow = day.getDay();
      const count = dow === 0 || dow === 6 ? rnd(9, 17) : rnd(3, 9);
      for (let n = 0; n < count; n++) {
        let gid = groupPick(); if (!byGroup[gid]) gid = pick(groupIds);
        const lines = rnd(1, 3);
        const items = [];
        let sum = 0;
        for (let k = 0; k < lines; k++) {
          const p = pick(byGroup[gid]);
          const qty = rnd(1, 4);
          const lineSum = Number(p.price) * qty;
          sum += lineSum;
          items.push({ p, qty, lineSum });
        }
        const method = methodPick();
        const cash = method === 'cash' ? sum : 0;
        const card = method === 'cash' ? 0 : sum;
        // случайное время в пределах дня
        const ts = new Date(day); ts.setHours(rnd(10, 20), rnd(0, 59), rnd(0, 59), 0);
        const sale = await cq(
          `INSERT INTO sales (cashier_id, total, cash_amount, card_amount, method, status, comment, created_at)
           VALUES ($1,$2,$3,$4,$5,'done',$6,$7) RETURNING id`,
          [pick(cashierIds), sum, cash, card, method, MARK, ts.toISOString()]
        );
        const saleId = sale[0].id;
        for (const it of items) {
          await cq(
            `INSERT INTO sale_items (sale_id, product_id, group_id, name, qty, price, sum)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [saleId, it.p.id, it.p.group_id, it.p.name, it.qty, it.p.price, it.lineSum]
          );
        }
        total++;
      }
    }
  });

  console.log(`[seed-history] создано продаж: ${total} за ${DAYS} дней`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedHistory()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => { console.error('[seed-history] ошибка:', err.message); process.exit(1); });
}
