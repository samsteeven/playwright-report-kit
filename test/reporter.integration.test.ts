import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error modules .mjs sans déclaration de types
import { createMockXray } from '../tools/mock-xray.mjs';
// @ts-expect-error modules .mjs sans déclaration de types
import { createTeamsSink } from '../tools/teams-sink.mjs';

const root = path.resolve(__dirname, '..');
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const config = path.join(root, 'test', 'fixtures', 'sample', 'playwright.config.ts');

const listen = (server: import('node:http').Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

interface RunResult { code: number | null; stdout: string }
function runPlaywright(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', '--config', config], { cwd: root, env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

describe('reporter dans un vrai run Playwright', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prk-run-'));
  const xray = createMockXray({ clientId: 'id', clientSecret: 'secret' });
  const teams = createTeamsSink();
  let result: RunResult;

  beforeAll(async () => {
    expect(fs.existsSync(path.join(root, 'dist', 'index.js')), 'lancer `npm run build` avant les tests').toBe(true);
    const [xrayPort, teamsPort] = await Promise.all([listen(xray.server), listen(teams.server)]);
    result = await runPlaywright({
      PRK_OUTPUT_DIR: out,
      XRAY_BASE_URL: `http://127.0.0.1:${xrayPort}`,
      XRAY_CLIENT_ID: 'id',
      XRAY_CLIENT_SECRET: 'secret',
      XRAY_PROJECT_KEY: 'DEMO',
      TEAMS_WEBHOOK_URL: `http://127.0.0.1:${teamsPort}/webhook`,
      PRK_REPORT_URL: 'https://ci.example.test/run/1',
    });
  });
  afterAll(() => {
    xray.server.close();
    teams.server.close();
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('laisse Playwright échouer avec un code non nul quand un test échoue', () => {
    expect(result.code).toBe(1);
  });

  it('écrit le rapport HTML, le JUnit et le résumé', () => {
    expect(fs.readdirSync(out).sort()).toEqual(expect.arrayContaining(['junit.xml', 'report.html', 'summary.json', 'xray-result.json']));
    const html = fs.readFileSync(path.join(out, 'report.html'), 'utf8');
    expect(html).toContain('Fixture');
    expect(html).toContain('paiement › échoue volontairement');
    expect(html).toContain('le total doit valoir 3');
    expect(html).not.toMatch(/\u001b\[/); // pas de séquences ANSI
  });

  it('compte correctement réussis, échec, instable et ignoré', () => {
    const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
    expect(summary.totals).toEqual({ total: 5, passed: 2, failed: 1, flaky: 1, skipped: 1 });
    const flaky = summary.tests.find((t: { title: string }) => t.title === 'instable');
    expect(flaky.attempts).toHaveLength(2);
    expect(flaky.status).toBe('flaky');
    const linked = summary.tests.find((t: { title: string }) => t.title === 'lié à Xray');
    expect(linked.xrayKey).toBe('DEMO-7');
    expect(linked.requirements).toEqual(['DEMO-1', 'DEMO-2']);
  });

  it('produit un JUnit valide avec les propriétés Xray', () => {
    const xml = fs.readFileSync(path.join(out, 'junit.xml'), 'utf8');
    const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (n) => ['testcase', 'property'].includes(n) }).parse(xml);
    const cases = doc.testsuites.testsuite.testcase as Array<Record<string, any>>;
    expect(cases).toHaveLength(5);
    expect(xml).toContain('name="test_key" value="DEMO-7"');
    expect(xml).toContain('name="requirements" value="DEMO-1,DEMO-2"');
    expect(xml).toContain('<failure');
    expect(xml).toContain('<skipped/>');
  });

  it('envoie le JUnit au faux Xray', () => {
    expect(xray.imports).toHaveLength(1);
    expect(xray.imports[0]).toMatchObject({ projectKey: 'DEMO', testcases: 5, linkedToKey: 1, failures: 1, skipped: 1 });
    const stored = JSON.parse(fs.readFileSync(path.join(out, 'xray-result.json'), 'utf8'));
    expect(stored).toMatchObject({ key: expect.stringMatching(/^DEMO-\d+$/), tests: 5, linkedToKey: 1 });
  });

  it('poste une carte dans le récepteur Teams parce qu\'un test échoue', () => {
    expect(teams.received).toHaveLength(1);
    const card = JSON.stringify(teams.received[0]);
    expect(card).toContain('1 test(s) en échec');
    expect(card).toContain('paiement › échoue volontairement');
    expect(card).toContain('https://ci.example.test/run/1');
  });
});
