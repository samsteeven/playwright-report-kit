import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMocks, mocksFromHar, slug, templateOf } from '../src/har/generate';
import type { Har } from '../src/har/generate';
import { applyMocks, loadMocks, matchMock } from '../src/har/runtime';

type Entry = Har['log']['entries'][number];
const entry = (method: string, url: string, status: number, body: unknown, over: Partial<Entry> = {}): Entry => ({
  startedDateTime: '2026-10-26T10:00:00.000Z',
  _resourceType: 'fetch',
  request: { method, url },
  response: {
    status,
    headers: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, { name: 'Set-Cookie', value: 'sid=SECRET123' }, { name: 'Server', value: 'nginx' }],
    content: { mimeType: 'application/json; charset=utf-8', text: JSON.stringify(body) },
  },
  ...over,
});

const har = (entries: Entry[]): Har => ({ log: { entries } });
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prk-har-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe('généralisation des chemins', () => {
  it('remplace les identifiants numériques, UUID et hexadécimaux longs', () => {
    expect(templateOf('/api/cases/42')).toBe('/api/cases/:id');
    expect(templateOf('/api/cases/3f2b8c1e-0a9d-4c1b-8f3e-1a2b3c4d5e6f/notes/7')).toBe('/api/cases/:id/notes/:id2');
    expect(templateOf('/api/files/9f86d081884c7d659a2feaa0c55ad015')).toBe('/api/files/:id');
    expect(templateOf('/api/cases/stats')).toBe('/api/cases/stats');
    expect(templateOf('/')).toBe('/');
  });

  it('fabrique des identifiants de fichier lisibles', () => {
    expect(slug('get', '/api/cases/:id')).toBe('GET_api_cases_id');
    expect(slug('POST', '/')).toBe('POST_root');
  });
});

describe('génération depuis un HAR', () => {
  it('fusionne les appels d\'une même route et garde le dernier par défaut', () => {
    const { mocks } = mocksFromHar(har([
      entry('GET', 'http://app.test/api/cases/1', 200, { id: 1, title: 'ancien' }),
      entry('GET', 'http://app.test/api/cases/2', 200, { id: 2, title: 'récent' }),
    ]));
    expect(mocks).toHaveLength(1);
    expect(mocks[0]).toMatchObject({ id: 'GET_api_cases_id', pathTemplate: '/api/cases/:id', body: { id: 2, title: 'récent' }, source: { recordedCalls: 2 } });
    expect(mocksFromHar(har([entry('GET', 'http://app.test/api/cases/1', 200, { n: 1 }), entry('GET', 'http://app.test/api/cases/2', 200, { n: 2 })]), { pick: 'first' }).mocks[0]!.body).toEqual({ n: 1 });
  });

  it('signale les statuts différents vus pour une même route', () => {
    const { mocks } = mocksFromHar(har([entry('POST', 'http://app.test/api/login', 401, { error: 'no' }), entry('POST', 'http://app.test/api/login', 200, { ok: true })]));
    expect(mocks[0]!.status).toBe(200);
    expect(mocks[0]!.notes?.[0]).toContain('401, 200');
  });

  it('écarte les ressources statiques, les requêtes sans réponse et applique include/exclude', () => {
    const page: Entry = { ...entry('GET', 'http://app.test/', 200, 'x'), _resourceType: 'document', response: { status: 200, content: { mimeType: 'text/html', text: '<html>' } } };
    const aborted = entry('GET', 'http://app.test/api/x', 0, {});
    const result = mocksFromHar(har([page, aborted, entry('GET', 'http://app.test/api/a', 200, {}), entry('GET', 'http://app.test/analytics/b', 200, {})]), { exclude: [/analytics/] });
    expect(result.mocks.map((m) => m.id)).toEqual(['GET_api_a']);
    const reasons = result.skipped.map((s) => s.reason).join(' | ');
    expect(reasons).toContain('statique');
    expect(reasons).toContain('absente');
    expect(reasons).toContain('--exclude');
    expect(mocksFromHar(har([entry('GET', 'http://app.test/api/a', 200, {}), entry('GET', 'http://app.test/api/b', 200, {})]), { include: [/\/api\/b/] }).mocks.map((m) => m.id)).toEqual(['GET_api_b']);
  });

  it('retire les en-têtes sensibles et masque les jetons du corps JSON', () => {
    const { mocks, redactions } = mocksFromHar(har([
      entry('POST', 'http://app.test/api/login', 200, { user: { id: 1, name: 'Aïcha' }, accessToken: 'eyJ.secret.value', refresh_token: 'abc', nested: [{ password: 'p', note: 'ok' }] }),
    ]));
    const mock = mocks[0]!;
    expect(mock.headers).toEqual({ 'content-type': 'application/json; charset=utf-8' });
    expect(JSON.stringify(mock)).not.toContain('SECRET123');
    expect(JSON.stringify(mock)).not.toContain('eyJ.secret.value');
    expect(mock.body).toMatchObject({ user: { id: 1, name: 'Aïcha' }, accessToken: '[REDACTED]', refresh_token: '[REDACTED]', nested: [{ password: '[REDACTED]', note: 'ok' }] });
    expect(redactions).toBe(3);
  });

  it('peut désactiver le masquage', () => {
    const { mocks, redactions } = mocksFromHar(har([entry('POST', 'http://app.test/api/login', 200, { accessToken: 'abc' })]), { redactKeys: false });
    expect(mocks[0]!.body).toEqual({ accessToken: 'abc' });
    expect(redactions).toBe(0);
  });

  it('garde un corps binaire en base64 et un corps non JSON en texte', () => {
    const bin: Entry = { ...entry('GET', 'http://app.test/api/doc', 200, ''), response: { status: 200, content: { mimeType: 'application/pdf', text: 'JVBERi0=', encoding: 'base64' } } };
    const txt: Entry = { ...entry('GET', 'http://app.test/api/ping', 200, ''), response: { status: 200, content: { mimeType: 'text/plain', text: 'pong' } } };
    const { mocks } = mocksFromHar(har([bin, txt]));
    expect(mocks.find((m) => m.id === 'GET_api_doc')?.bodyBase64).toBe('JVBERi0=');
    expect(mocks.find((m) => m.id === 'GET_api_ping')?.bodyText).toBe('pong');
  });
});

describe('écriture des fichiers', () => {
  it('écrit un fichier par route et un index, et repart propre à la régénération', () => {
    const dir = tmp();
    const harFile = path.join(dir, 'rec.har');
    const out = path.join(dir, 'mocks');
    fs.writeFileSync(harFile, JSON.stringify(har([entry('GET', 'http://app.test/api/a', 200, { a: 1 }), entry('GET', 'http://app.test/api/b', 200, { b: 1 })])));
    const first = generateMocks(harFile, out);
    expect(fs.readdirSync(out).sort()).toEqual(['GET_api_a.json', 'GET_api_b.json', 'index.json']);
    expect(first.written).toHaveLength(3);

    fs.writeFileSync(harFile, JSON.stringify(har([entry('GET', 'http://app.test/api/a', 200, { a: 2 })])));
    generateMocks(harFile, out);
    expect(fs.readdirSync(out).sort()).toEqual(['GET_api_a.json', 'index.json']);
    expect(loadMocks(out)).toHaveLength(1);
  });

  it('refuse un fichier qui n\'est pas un HAR', () => {
    const dir = tmp();
    const file = path.join(dir, 'x.har');
    fs.writeFileSync(file, '{"foo":1}');
    expect(() => generateMocks(file, path.join(dir, 'o'))).toThrow(/n'est pas un fichier HAR/);
  });
});

describe('application des mocks', () => {
  const mocks = mocksFromHar(har([
    entry('GET', 'http://app.test/api/cases/stats', 200, { total: 3 }),
    entry('GET', 'http://app.test/api/cases/9', 200, { id: 9 }),
    entry('POST', 'http://app.test/api/cases', 201, { id: 10 }),
  ])).mocks;

  it('choisit la route la plus précise : /stats gagne sur /:id', () => {
    expect(matchMock(mocks, 'GET', '/api/cases/stats')?.pathTemplate).toBe('/api/cases/stats');
    expect(matchMock(mocks, 'GET', '/api/cases/123')?.pathTemplate).toBe('/api/cases/:id');
    expect(matchMock(mocks, 'DELETE', '/api/cases/123')).toBeUndefined();
    expect(matchMock(mocks, 'GET', '/api/cases/12/notes')).toBeUndefined();
  });

  /** Page factice : enregistre le prédicat et le gestionnaire passés à `route`. */
  function fakePage() {
    let predicate: (url: URL) => boolean = () => false;
    let handler: (route: unknown) => Promise<unknown> = async () => undefined;
    const page = { route: vi.fn(async (p: typeof predicate, h: typeof handler) => { predicate = p; handler = h; }) };
    const call = async (method: string, url: string) => {
      const route = { request: () => ({ method: () => method, url: () => url }), fulfill: vi.fn(), fallback: vi.fn(), abort: vi.fn() };
      if (predicate(new URL(url))) await handler(route);
      return route;
    };
    return { page, call };
  }

  it('répond avec le statut, le type et le corps du mock', async () => {
    const { page, call } = fakePage();
    const { hits } = await applyMocks(page as never, mocks);
    const route = await call('GET', 'http://localhost:3000/api/cases/55');
    expect(route.fulfill).toHaveBeenCalledWith({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, contentType: 'application/json', body: '{"id":9}' });
    expect(hits.get('GET_api_cases_id')).toBe(1);
  });

  it('laisse passer une méthode sans mock, ou la refuse selon l\'option', async () => {
    const fallback = fakePage();
    await applyMocks(fallback.page as never, mocks);
    expect((await fallback.call('DELETE', 'http://localhost/api/cases/1')).fallback).toHaveBeenCalled();

    const abort = fakePage();
    await applyMocks(abort.page as never, mocks, { onMiss: 'abort' });
    expect((await abort.call('DELETE', 'http://localhost/api/cases/1')).abort).toHaveBeenCalled();

    const strict = fakePage();
    await applyMocks(strict.page as never, mocks, { onMiss: 'error' });
    await expect(strict.call('DELETE', 'http://localhost/api/cases/1')).rejects.toThrow(/Aucun mock/);
  });

  it('n\'intercepte pas les URL hors des routes mockées ni les autres origines', async () => {
    const { page, call } = fakePage();
    await applyMocks(page as never, mocks, { origin: 'http://localhost:3000' });
    expect((await call('GET', 'http://localhost:3000/assets/app.js')).fulfill).not.toHaveBeenCalled();
    expect((await call('GET', 'http://autre.test/api/cases/1')).fulfill).not.toHaveBeenCalled();
    expect((await call('GET', 'http://localhost:3000/api/cases/1')).fulfill).toHaveBeenCalled();
  });

  it('permet de remplacer un mock pour un cas d\'erreur', async () => {
    const { page, call } = fakePage();
    await applyMocks(page as never, mocks, { overrides: { GET_api_cases_id: { status: 500, body: { error: 'down' } } } });
    const route = await call('GET', 'http://localhost/api/cases/1');
    expect(route.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: 500, body: '{"error":"down"}' }));
  });
});
