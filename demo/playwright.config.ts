import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env['DEMO_PORT'] ?? 4310);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [
    ['list'],
    // Le reporter du dépôt (en usage réel : ['playwright-report-kit', { ... }]).
    [path.resolve(__dirname, '../dist/index.js'), { title: 'Démo : formulaire de contact', outputDir: 'report-kit' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
    locale: 'fr-FR',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node app/server.mjs',
    url: `http://127.0.0.1:${port}`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env['CI'],
    cwd: __dirname,
  },
});
