// Обнуление кассы: смены, продажи, чеки и всё, что к ним привязано.
//
// Зачем: перед запуском в работу надо убрать тестовые пробития, чтобы отчёты,
// выручка и смены начались с нуля.
//
// Что удаляется:
//   • кассовые смены (cash_shifts);
//   • продажи и возвраты (sales) вместе с позициями чека (sale_items) и
//     фискальными документами (fiscal_docs) — они уходят каскадом;
//   • бонусные операции, привязанные к продажам (оплата бонусами, кэшбэк);
//   • абонементы, выданные по этим чекам, вместе с историей посещений;
//   • движения товара по продажам и возвратам (stock_moves reason='sale'/'return').
//
// Что НЕ трогается:
//   • клиенты, их карты, дети и реферальные коды;
//   • каталог: билеты, товары, услуги, комнаты, виды абонементов;
//   • остатки товара (products.stock) — их поправит инвентаризация;
//   • приходы и инвентаризации в истории движений;
//   • брони и журнал мероприятий, заявки воронки, пользователи, настройки.
//
// Балансы бонусов клиентов пересчитываются по оставшимся операциям, чтобы база
// осталась согласованной: ручные начисления и приветственные бонусы сохранятся.
//
// Запуск (на сервере, из папки проекта):
//   docker compose exec -T app node src/reset-pos.js         — только показать, что удалится
//   docker compose exec -T app node src/reset-pos.js --yes   — удалить
import { pool, q1, tx } from './db.js';

const CONFIRM = process.argv.includes('--yes');

async function counts() {
  const row = await q1(`
    SELECT
      (SELECT count(*) FROM cash_shifts)::int                                   AS shifts,
      (SELECT count(*) FROM sales WHERE NOT is_return)::int                     AS sales,
      (SELECT count(*) FROM sales WHERE is_return)::int                         AS returns,
      (SELECT count(*) FROM sale_items)::int                                    AS items,
      (SELECT count(*) FROM fiscal_docs)::int                                   AS fiscal,
      (SELECT count(*) FROM loyalty_transactions WHERE sale_id IS NOT NULL)::int AS loyalty,
      (SELECT count(*) FROM passes WHERE sale_id IS NOT NULL)::int              AS passes,
      (SELECT count(*) FROM stock_moves WHERE reason IN ('sale','return'))::int AS moves
  `);
  return row;
}

function report(c, title) {
  console.log(title);
  console.log('  смены:                 ' + c.shifts);
  console.log('  продажи:               ' + c.sales);
  console.log('  возвраты:              ' + c.returns);
  console.log('  позиции чеков:         ' + c.items);
  console.log('  фискальные документы:  ' + c.fiscal);
  console.log('  бонусные операции:     ' + c.loyalty);
  console.log('  абонементы по чекам:   ' + c.passes);
  console.log('  движения товара:       ' + c.moves);
}

async function main() {
  const before = await counts();
  report(before, '\n[касса] Сейчас в базе:');

  const total = before.shifts + before.sales + before.returns;
  if (total === 0) {
    console.log('\n[касса] Обнулять нечего — смен и продаж нет.');
    return;
  }

  if (!CONFIRM) {
    console.log('\n[касса] Это сухой прогон, НИЧЕГО не удалено.');
    console.log('[касса] Клиенты, каталог и настройки в любом случае остаются.');
    console.log('[касса] Чтобы удалить перечисленное, запустите ту же команду с --yes');
    return;
  }

  await tx(async ({ q: cq }) => {
    // Абонементы, выданные по чекам: история посещений уходит каскадом.
    // Служебно выданные (без чека) остаются.
    await cq('DELETE FROM passes WHERE sale_id IS NOT NULL');
    // Бонусные операции по продажам. Ручные начисления и приветственные
    // бонусы не привязаны к продаже и сохраняются.
    await cq('DELETE FROM loyalty_transactions WHERE sale_id IS NOT NULL');
    // Движения товара по кассе. Приходы и инвентаризации остаются.
    await cq(`DELETE FROM stock_moves WHERE reason IN ('sale','return')`);
    // Продажи: позиции чека и фискальные документы уходят каскадом.
    // Сначала снимаем ссылку возврата на исходную продажу, чтобы не мешал
    // внешний ключ sales.parent_sale_id.
    await cq('UPDATE sales SET parent_sale_id = NULL WHERE parent_sale_id IS NOT NULL');
    await cq('DELETE FROM sales');
    await cq('DELETE FROM cash_shifts');
    // Балансы бонусов — по оставшимся операциям, чтобы карта клиента и его
    // история сходились между собой.
    await cq(`
      UPDATE clients c
         SET bonus = COALESCE((SELECT SUM(points) FROM loyalty_transactions t
                                WHERE t.client_id = c.id), 0)
    `);
  });

  const after = await counts();
  report(after, '\n[касса] После обнуления:');
  console.log('\n[касса] Готово. Смены и продажи обнулены, клиенты и каталог на месте.');
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[касса] ошибка:', err.message);
    process.exit(1);
  });
