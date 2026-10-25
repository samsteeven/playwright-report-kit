import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHtml } from '../src/html';
import { buildCard, buildPayload, postToTeams, shouldNotify, teamsFromEnv } from '../src/teams';
import { uploadJUnit, XrayError, xrayFromEnv } from '../src/xray';
// @ts-expect-error module .mjs sans déclaration de types
import { createMockXray } from '../tools/mock-xray.mjs';
import { record, summary } from './helpers';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('rapport HTML', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prk-html-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('échappe les titres et les erreurs : aucune balise injectée', () => {
    const evil = '<img src=x onerror=alert(1)> & "guillemets"';
    const html = renderHtml(summary([record({ title: evil, fullTitle: evil, status: 'failed', errors: [`<script>alert('x')</script>`] })]), { reportDir: dir });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain("<script>alert('x')");
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
    // Le seul script de la page est celui du rapport (filtres).
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it('affiche les totaux, les échecs ouverts et la clé Xray', () => {
    const html = renderHtml(summary([record({ xrayKey: 'TJ-12' }), record({ status: 'failed', errors: ['boom'] }), record({ status: 'skipped' })]), { reportDir: dir });
    expect(html).toContain('<b>3</b><span>Tests</span>');
    expect(html).toContain('<b>1</b><span>En échec</span>');
    expect(html).toContain('TJ-12');
    expect(html).toMatch(/<details class="test" data-status="failed"[^>]* open>/);
    expect(html).toContain('lang="fr"');
  });

  it('intègre les petites captures et lie les grosses', () => {
    const small = path.join(dir, 'small.png');
    const big = path.join(dir, 'sub', 'big.png');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(small, PNG_1PX);
    fs.writeFileSync(big, Buffer.alloc(2000, 1));
    const html = renderHtml(
      summary([record({ status: 'failed', errors: ['x'], attachments: [
        { name: 'petite', contentType: 'image/png', path: small },
        { name: 'grosse', contentType: 'image/png', path: big },
        { name: 'trace', contentType: 'application/zip', path: path.join(dir, 'trace dir', 'trace.zip') },
      ] })]),
      { reportDir: dir, maxEmbedBytes: 1000 },
    );
    expect(html).toContain('src="data:image/png;base64,');
    expect(html.match(/data:image\/png/g)).toHaveLength(1);
    expect(html).toContain('href="sub/big.png"');
    expect(html).toContain('href="trace%20dir/trace.zip"');
  });

  it('reste valide avec zéro test', () => {
    const html = renderHtml(summary([]), { reportDir: dir });
    expect(html).toContain('<b>0</b><span>Tests</span>');
  });
});

describe('notification Teams', () => {
  const failing = summary([record({ title: 'paie', fullTitle: 'paiement › paie', status: 'failed', errors: ['Timeout 15000ms exceeded\nsuite'] }), record()]);

  it('construit une carte adaptative dans l\'enveloppe attendue par Power Automate', () => {
    const payload = buildPayload(failing, { reportUrl: 'https://ci.example.test/run/1' });
    expect(payload.type).toBe('message');
    expect(payload.attachments[0]!.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = payload.attachments[0]!.content;
    expect(card.type).toBe('AdaptiveCard');
    expect(JSON.stringify(card)).toContain('1 test(s) en échec');
    expect(JSON.stringify(card)).toContain('paiement › paie');
    expect(JSON.stringify(card)).toContain('Timeout 15000ms exceeded');
    expect(card.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Ouvrir le rapport', url: 'https://ci.example.test/run/1' }]);
  });

  it('est verte quand tout passe', () => {
    const card = buildCard(summary([record()]), {});
    expect(JSON.stringify(card)).toContain('tous les tests passent');
    expect(card.actions).toBeUndefined();
  });

  it('reste sous la limite de taille avec des centaines d\'échecs', () => {
    const many = summary(Array.from({ length: 600 }, (_, i) => record({ id: `t${i}`, fullTitle: `test numéro ${i} ${'x'.repeat(100)}`, status: 'failed', errors: ['e'.repeat(2000)] })));
    const payload = buildPayload(many, {});
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(24_000);
  });

  it('notifie selon le mode', () => {
    expect(shouldNotify('never', failing)).toBe(false);
    expect(shouldNotify('always', summary([record()]))).toBe(true);
    expect(shouldNotify('failure', summary([record()]))).toBe(false);
    expect(shouldNotify('failure', failing)).toBe(true);
    expect(shouldNotify('failure', summary([record()], { status: 'interrupted' }))).toBe(true);
  });

  it('poste le JSON et signale un refus', async () => {
    const ok = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    await postToTeams('https://flow.example.test/hook', { a: 1 }, ok);
    expect(ok).toHaveBeenCalledWith('https://flow.example.test/hook', expect.objectContaining({ method: 'POST', body: '{"a":1}' }));
    const refused = vi.fn().mockResolvedValue(new Response('flow disabled', { status: 400 }));
    await expect(postToTeams('https://flow.example.test/hook', {}, refused)).rejects.toThrow(/HTTP 400.*flow disabled/);
  });

  it('lit la configuration dans l\'environnement', () => {
    expect(teamsFromEnv({})).toBeUndefined();
    expect(teamsFromEnv({ TEAMS_WEBHOOK_URL: 'https://x', PRK_NOTIFY: 'always', PRK_REPORT_URL: 'https://r' })).toEqual({ webhookUrl: 'https://x', notify: 'always', reportUrl: 'https://r' });
    expect(teamsFromEnv({ TEAMS_WEBHOOK_URL: 'https://x', PRK_NOTIFY: 'bizarre' })?.notify).toBe('failure');
  });
});

describe('import Xray (contre le faux serveur du dépôt)', () => {
  const mock = createMockXray({ clientId: 'id-test', clientSecret: 'secret-test' });
  let baseUrl = '';
  const xml = '<testsuites><testsuite><testcase name="a"><properties><property name="test_key" value="TJ-1"/></properties></testcase><testcase name="b"><failure message="x"/></testcase></testsuite></testsuites>';
  const options = (over = {}) => ({ baseUrl, clientId: 'id-test', clientSecret: 'secret-test', projectKey: 'TJ', ...over });

  beforeAll(async () => {
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => mock.server.close(() => resolve())));

  it('s\'authentifie puis importe le fichier', async () => {
    const result = await uploadJUnit(xml, options({ testExecKey: 'TJ-77' }));
    expect(result.key).toBe('TJ-77');
    const last = mock.imports.at(-1);
    expect(last).toMatchObject({ projectKey: 'TJ', testcases: 2, linkedToKey: 1, failures: 1 });
  });

  it('crée une exécution quand aucune n\'est fournie', async () => {
    const result = await uploadJUnit(xml, options());
    expect(result.key).toMatch(/^TJ-\d+$/);
  });

  it('ne réessaie pas après un refus d\'identifiants et ne divulgue pas le secret', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const error = await uploadJUnit(xml, options({ clientSecret: 'mauvais-secret-xyz' }), { sleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XrayError);
    expect((error as XrayError).status).toBe(401);
    expect((error as XrayError).message).not.toContain('mauvais-secret-xyz');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('réessaie les erreurs 5xx puis réussit', async () => {
    const real = globalThis.fetch;
    let calls = 0;
    const flaky = async (input: string, init?: RequestInit) => {
      if (input.includes('/import/') && ++calls === 1) return new Response('boom', { status: 503 });
      return real(input, init);
    };
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await uploadJUnit(xml, options(), { fetch: flaky, sleep });
    expect(result.key).toMatch(/^TJ-\d+$/);
    expect(calls).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('abandonne après le nombre d\'essais prévu', async () => {
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(uploadJUnit(xml, options(), { fetch: down, sleep, attempts: 3 })).rejects.toThrow('ECONNREFUSED');
    expect(down).toHaveBeenCalledTimes(3);
  });

  it('remonte un XML refusé par Xray', async () => {
    await expect(uploadJUnit('<testsuites/>', options(), { sleep: async () => {} })).rejects.toThrow(/HTTP 400.*no testcase/);
  });

  it('lit la configuration dans l\'environnement', () => {
    expect(xrayFromEnv({ XRAY_PROJECT_KEY: 'TJ' })).toBeUndefined();
    expect(xrayFromEnv({ XRAY_PROJECT_KEY: 'TJ', XRAY_CLIENT_ID: 'a', XRAY_CLIENT_SECRET: 'b' })).toMatchObject({ baseUrl: 'https://xray.cloud.getxray.app', projectKey: 'TJ' });
    expect(xrayFromEnv({ XRAY_PROJECT_KEY: 'TJ', XRAY_CLIENT_ID: 'a', XRAY_CLIENT_SECRET: 'b', XRAY_BASE_URL: 'http://localhost:4400/' })?.baseUrl).toBe('http://localhost:4400');
  });
});
