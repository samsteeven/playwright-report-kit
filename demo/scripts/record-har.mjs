// Enregistre un parcours réel de la démo dans un fichier HAR (appels d'API seulement), puis on en tire des mocks :
//   node demo/scripts/record-har.mjs
//   npx prk har-mocks demo/recordings/contact.har --out demo/mocks
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createApp } from '../app/server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const harPath = path.join(here, '..', 'recordings', 'contact.har');

const server = createApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ recordHar: { path: harPath, urlFilter: '**/api/**' } });
const page = await context.newPage();

await page.goto(base);
await page.locator('#topic option[value="2"]').waitFor({ state: 'attached' });

// Premier envoi : nom trop court, le serveur répond 422 (utile pour voir la note « statuts différents »).
await page.fill('#name', 'A');
await page.fill('#email', 'aicha@example.test');
await page.selectOption('#topic', '2');
await page.fill('#message', 'Mon paiement a été refusé hier.');
await page.check('#consent');
await page.click('button[type=submit]');
await page.locator('#err-name:not(:empty)').waitFor();

// Second envoi : valide, le serveur répond 201.
await page.fill('#name', 'Aïcha Ndiaye');
await page.click('button[type=submit]');
await page.locator('#confirmation:not([hidden])').waitFor();

await context.close(); // c'est la fermeture du contexte qui écrit le HAR
await browser.close();
server.close();
console.log(`HAR écrit : ${path.relative(process.cwd(), harPath)}`);
