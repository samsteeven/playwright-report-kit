// Prend les captures du rapport pour le README (docs/*.png) : node tools/screenshot-report.mjs <report.html>
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const report = path.resolve(process.argv[2] ?? 'demo/report-kit/report.html');
const out = path.resolve('docs');
const browser = await chromium.launch();
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
  await page.goto(pathToFileURL(report).href);
  await page.screenshot({ path: path.join(out, `rapport-${scheme}.png`), fullPage: true });
  await page.close();
}
await browser.close();
console.log('captures écrites dans docs/');
