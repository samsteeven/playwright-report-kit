import path from 'node:path';
import { expect, test } from '@playwright/test';
import { applyMocks } from '../../dist/index.js';

const MOCKS = path.resolve(__dirname, '../mocks');

async function fillValidForm(page: import('@playwright/test').Page) {
  await page.getByLabel('Nom').fill('Aïcha Ndiaye');
  await page.getByLabel('Adresse e-mail').fill('aicha@example.test');
  await page.getByLabel('Thème').selectOption({ label: 'Problème de paiement' });
  await page.getByLabel('Message', { exact: true }).fill('Mon paiement a été refusé hier soir.');
  await page.getByLabel("J'accepte le traitement de mon message").check();
}

test.describe('formulaire de contact', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('charge les thèmes depuis l\'API', { tag: '@DEMO-1' }, async ({ page }) => {
    await expect(page.getByLabel('Thème').locator('option')).toHaveText(['Choisir…', 'Question générale', 'Problème de paiement', 'Demande de rendez-vous']);
  });

  test('envoie le message et affiche la référence', { tag: '@DEMO-2', annotation: { type: 'requirement', description: 'DEMO-100' } }, async ({ page }) => {
    await expect(page.getByLabel('Thème').locator('option')).toHaveCount(4);
    await fillValidForm(page);
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByRole('status')).toContainText(/référence CT-\d{4}/);
  });

  test('refuse une adresse e-mail invalide', { tag: '@DEMO-3' }, async ({ page }) => {
    await fillValidForm(page);
    await page.getByLabel('Adresse e-mail').fill('pas-une-adresse');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByText('Adresse e-mail invalide.')).toBeVisible();
  });

  test('exige le consentement', { tag: '@DEMO-4' }, async ({ page }) => {
    await fillValidForm(page);
    await page.getByLabel("J'accepte le traitement de mon message").uncheck();
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByText('Vous devez accepter le traitement de votre message.')).toBeVisible();
  });

  test('affiche les erreurs de validation renvoyées par le serveur', { tag: '@DEMO-5' }, async ({ page }) => {
    await fillValidForm(page);
    await page.getByLabel('Nom').fill('A');
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByText('Indiquez votre nom (2 caractères minimum).')).toBeVisible();
  });

  test.fixme('joint une pièce jointe (fonction à venir)', { tag: '@DEMO-9' }, async () => {});
});

test.describe('avec les mocks générés depuis le HAR', () => {
  test('fonctionne sans backend : thèmes et confirmation viennent des mocks', { tag: '@DEMO-6' }, async ({ page }) => {
    const { hits } = await applyMocks(page, MOCKS);
    await page.goto('/');
    await fillValidForm(page);
    await page.getByRole('button', { name: 'Envoyer' }).click();
    // La référence est celle enregistrée dans le HAR, pas une nouvelle : c'est bien le mock qui répond.
    await expect(page.getByRole('status')).toContainText('CT-0001');
    expect(hits.get('GET_api_topics')).toBe(1);
    expect(hits.get('POST_api_contact')).toBe(1);
  });

  test('simule une panne du serveur en remplaçant un mock', { tag: '@DEMO-7' }, async ({ page }) => {
    await applyMocks(page, MOCKS, { overrides: { POST_api_contact: { status: 500, body: { error: 'down' } } } });
    await page.goto('/');
    await fillValidForm(page);
    await page.getByRole('button', { name: 'Envoyer' }).click();
    await expect(page.getByText('Erreur inattendue, réessayez plus tard.')).toBeVisible();
  });
});

// Échecs de démonstration, activés à la demande pour montrer comment le rapport présente un échec et un test instable :
//   DEMO_FAIL=1 npm run demo:test
test.describe('échecs de démonstration', () => {
  test.skip(!process.env['DEMO_FAIL'], 'activé par DEMO_FAIL=1');

  test('affiche un récapitulatif de la demande (cassé exprès)', { tag: '@DEMO-8' }, async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Récapitulatif' }), 'le titre devrait exister').toBeVisible({ timeout: 1500 });
  });

  test('instable : réussit à la relance', { tag: '@DEMO-10' }, async ({ page }, info) => {
    test.info().annotations.push({ type: 'note', description: 'échoue à la première tentative' });
    await page.goto('/');
    expect(info.retry, 'première tentative volontairement en échec').toBeGreaterThan(0);
  });
});
