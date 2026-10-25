import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Projet minimal pour le test d'intégration : aucun navigateur, seulement des assertions.
// Le reporter est celui du paquet compilé (dist), configuré par l'environnement du test.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  retries: 1,
  workers: 1,
  reporter: [[path.resolve(__dirname, '../../../dist/index.js'), { title: 'Fixture' }]],
});
