// Сборка печатного макета: promo/app-a4.html → PDF и PNG-превью.
//
// Запуск (нужен playwright-core и Chromium):
//   node promo/render.js promo/app-a4.html promo/chailand-app-a4
//
// PDF — то, что отдают в печать (А4, без полей, с фоном).
// PNG — превью для согласования, А4 при ~192 dpi.
const { chromium } = require('playwright-core');
const path = require('path').resolve(process.argv[2] || 'promo/app-a4.html');
const out = process.argv[3] || 'promo/chailand-app-a4';
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] });
  const page = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  await page.pdf({ path: out + '.pdf', format: 'A4', printBackground: true,
                   margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await page.screenshot({ path: out + '.png' });
  await b.close();
  console.log('готово:', out + '.pdf', out + '.png');
})();
