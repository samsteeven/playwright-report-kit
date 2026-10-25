import { expect, test } from '@playwright/test';

test.describe('paiement', () => {
  test('réussit', { tag: '@smoke' }, async () => {
    expect(1 + 1).toBe(2);
  });

  test('échoue volontairement', async () => {
    expect(1 + 1, 'le total doit valoir 3').toBe(3);
  });
});

test('ignoré', async () => {
  test.skip(true, 'raison de l\'ignorance');
});

test('instable', async ({}, info) => {
  // Échoue à la première tentative, réussit à la relance.
  expect(info.retry).toBeGreaterThan(0);
});

test('lié à Xray', { tag: '@DEMO-7', annotation: { type: 'requirement', description: 'DEMO-1, DEMO-2' } }, async () => {
  expect(true).toBe(true);
});
