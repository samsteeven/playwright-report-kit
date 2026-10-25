import { defineConfig } from 'vitest/config';

// Les fichiers *.spec.ts du dépôt sont des tests Playwright (démo et fixtures), pas des tests Vitest.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000 },
});
