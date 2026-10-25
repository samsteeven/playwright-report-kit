import { truncate } from './util';

export interface XrayOptions {
  /** `https://xray.cloud.getxray.app` pour Xray Cloud ; une adresse locale pour le serveur simulé du dépôt. */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  projectKey: string;
  /** Test Execution existante à compléter ; sinon Xray en crée une. */
  testExecKey?: string;
  testPlanKey?: string;
  revision?: string;
}

export interface XrayImportResult {
  id: string;
  key: string;
  self?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UploadDeps {
  fetch?: FetchLike;
  /** Pause entre deux essais ; injectable pour que les tests n'attendent pas. */
  sleep?: (ms: number) => Promise<void>;
  /** Nombre d'essais pour les erreurs réseau et les 5xx (défaut 3). */
  attempts?: number;
  timeoutMs?: number;
}

export class XrayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'XrayError';
  }
}

const DEFAULT_BASE_URL = 'https://xray.cloud.getxray.app';

/** Lit la configuration Xray dans l'environnement ; `undefined` si la clé de projet ou les identifiants manquent. */
export function xrayFromEnv(env: NodeJS.ProcessEnv = process.env): XrayOptions | undefined {
  const { XRAY_CLIENT_ID: clientId, XRAY_CLIENT_SECRET: clientSecret, XRAY_PROJECT_KEY: projectKey } = env;
  if (!clientId || !clientSecret || !projectKey) return undefined;
  return {
    baseUrl: (env['XRAY_BASE_URL'] ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    clientId,
    clientSecret,
    projectKey,
    ...(env['XRAY_TEST_EXEC_KEY'] ? { testExecKey: env['XRAY_TEST_EXEC_KEY'] } : {}),
    ...(env['XRAY_TEST_PLAN_KEY'] ? { testPlanKey: env['XRAY_TEST_PLAN_KEY'] } : {}),
  };
}

async function withRetries<T>(task: () => Promise<T>, deps: UploadDeps): Promise<T> {
  const attempts = deps.attempts ?? 3;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      // Une réponse 4xx (identifiants refusés, XML invalide) ne se corrige pas en réessayant.
      const retryable = !(error instanceof XrayError) || error.status === undefined || error.status >= 500;
      if (!retryable || i === attempts) break;
      await sleep(500 * 2 ** (i - 1));
    }
  }
  throw lastError;
}

async function authenticate(options: XrayOptions, deps: UploadDeps): Promise<string> {
  const doFetch = deps.fetch ?? fetch;
  const response = await doFetch(`${options.baseUrl}/api/v2/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new XrayError(`Authentification Xray refusée (HTTP ${response.status}) : ${truncate(text, 200)}`, response.status);
  }
  // La réponse est une chaîne JSON entre guillemets.
  const token = text.trim().replace(/^"|"$/g, '');
  if (!token) throw new XrayError('Authentification Xray : jeton vide');
  return token;
}

/** Envoie un fichier JUnit XML à Xray (`POST /api/v2/import/execution/junit`) et renvoie la Test Execution touchée. */
export async function uploadJUnit(xml: string, options: XrayOptions, deps: UploadDeps = {}): Promise<XrayImportResult> {
  const doFetch = deps.fetch ?? fetch;
  return withRetries(async () => {
    const token = await authenticate(options, deps);
    const query = new URLSearchParams({ projectKey: options.projectKey });
    if (options.testExecKey) query.set('testExecKey', options.testExecKey);
    if (options.testPlanKey) query.set('testPlanKey', options.testPlanKey);
    if (options.revision) query.set('revision', options.revision);

    const response = await doFetch(`${options.baseUrl}/api/v2/import/execution/junit?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', Authorization: `Bearer ${token}` },
      body: xml,
      signal: AbortSignal.timeout(deps.timeoutMs ?? 60_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new XrayError(`Import Xray refusé (HTTP ${response.status}) : ${truncate(text, 300)}`, response.status);
    }
    let parsed: Partial<XrayImportResult>;
    try {
      parsed = JSON.parse(text) as Partial<XrayImportResult>;
    } catch {
      throw new XrayError(`Réponse Xray illisible : ${truncate(text, 200)}`);
    }
    if (!parsed.key || !parsed.id) throw new XrayError(`Réponse Xray sans clé d'exécution : ${truncate(text, 200)}`);
    return { id: parsed.id, key: parsed.key, ...(parsed.self ? { self: parsed.self } : {}) };
  }, deps);
}
