import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, Route } from '@playwright/test';
import type { MockDefinition } from './generate';

export interface ApplyOptions {
  /** Ne répond que pour cette origine (`http://localhost:3000`). Défaut : toutes, seul le chemin compte. */
  origin?: string;
  /** Requête sans mock : la laisser passer (`fallback`, défaut), l'annuler (`abort`) ou faire échouer le test (`error`). */
  onMiss?: 'fallback' | 'abort' | 'error';
  /** Remplace des champs d'un mock par son `id`, pour un cas particulier (une erreur 500, une liste vide). */
  overrides?: Record<string, Partial<MockDefinition>>;
}

export function loadMocks(dir: string): MockDefinition[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as MockDefinition);
}

function patternOf(template: string): RegExp {
  const source = template
    .split('/')
    .map((s) => (/^:id\d*$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}/?$`);
}

/** Les routes les plus précises d'abord : `/api/cases/stats` doit gagner sur `/api/cases/:id`. */
function bySpecificity(a: MockDefinition, b: MockDefinition): number {
  const params = (m: MockDefinition) => (m.pathTemplate.match(/:id\d*/g) ?? []).length;
  return params(a) - params(b) || b.pathTemplate.length - a.pathTemplate.length;
}

export function matchMock(mocks: MockDefinition[], method: string, pathname: string): MockDefinition | undefined {
  return [...mocks]
    .sort(bySpecificity)
    .find((m) => m.method.toUpperCase() === method.toUpperCase() && patternOf(m.pathTemplate).test(pathname));
}

function bodyOf(mock: MockDefinition): string | Buffer | undefined {
  if (mock.bodyBase64 !== undefined) return Buffer.from(mock.bodyBase64, 'base64');
  if (mock.bodyText !== undefined) return mock.bodyText;
  if (mock.body !== undefined) return JSON.stringify(mock.body);
  return undefined;
}

/**
 * Branche les mocks sur une page ou un contexte. Renvoie le nombre d'appels servis par mock,
 * pratique pour vérifier en fin de test que l'application a bien appelé l'API attendue.
 */
export async function applyMocks(
  target: Page | BrowserContext,
  source: string | MockDefinition[],
  options: ApplyOptions = {},
): Promise<{ hits: Map<string, number> }> {
  const base = typeof source === 'string' ? loadMocks(source) : source;
  const mocks = base.map((m) => ({ ...m, ...(options.overrides?.[m.id] ?? {}) }));
  const hits = new Map<string, number>();
  const covers = (url: URL) => (!options.origin || url.origin === options.origin) && mocks.some((m) => patternOf(m.pathTemplate).test(url.pathname));

  await target.route(covers, async (route: Route) => {
    const request = route.request();
    const mock = matchMock(mocks, request.method(), new URL(request.url()).pathname);
    if (!mock) {
      if (options.onMiss === 'abort') return route.abort();
      if (options.onMiss === 'error') throw new Error(`Aucun mock pour ${request.method()} ${request.url()}`);
      return route.fallback();
    }
    hits.set(mock.id, (hits.get(mock.id) ?? 0) + 1);
    const body = bodyOf(mock);
    return route.fulfill({
      status: mock.status,
      headers: mock.headers,
      ...(mock.contentType ? { contentType: mock.contentType } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  });
  return { hits };
}
