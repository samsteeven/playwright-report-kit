import fs from 'node:fs';
import path from 'node:path';

/** Sous-ensemble du format HAR 1.2 dont on a besoin. */
interface HarEntry {
  startedDateTime?: string;
  _resourceType?: string;
  request: { method: string; url: string };
  response: {
    status: number;
    statusText?: string;
    headers?: { name: string; value: string }[];
    content?: { mimeType?: string; text?: string; encoding?: string; size?: number };
  };
}
export interface Har {
  log: { entries: HarEntry[] };
}

export interface MockDefinition {
  /** Identifiant stable : `METHODE_chemin` (ex. `GET_api_cases_id`), aussi le nom du fichier sans extension. */
  id: string;
  method: string;
  /** Chemin avec des paramètres (`/api/cases/:id`) : les identifiants numériques, UUID et hexadécimaux longs sont généralisés. */
  pathTemplate: string;
  status: number;
  headers: Record<string, string>;
  contentType?: string;
  /** Corps JSON, éditable à la main. */
  body?: unknown;
  /** Corps texte (HTML, XML, texte brut). */
  bodyText?: string;
  /** Corps binaire encodé en base64. */
  bodyBase64?: string;
  source: { url: string; startedAt?: string; recordedCalls: number };
  /** Remarques utiles à la relecture (statuts différents vus pour la même route, par exemple). */
  notes?: string[];
}

export interface GenerateOptions {
  /** Ne garde que les URL qui correspondent à l'une de ces expressions (défaut : toutes). */
  include?: RegExp[];
  exclude?: RegExp[];
  /** Ignore les ressources statiques (pages, scripts, images, polices) et ne garde que les appels d'API (défaut : true). */
  apiOnly?: boolean;
  /** Quelle réponse garder quand une route a été appelée plusieurs fois (défaut : la dernière). */
  pick?: 'first' | 'last';
  /** Clés JSON dont la valeur est remplacée par `[REDACTED]`. `false` pour ne rien masquer. */
  redactKeys?: RegExp | false;
  /** En-têtes de réponse conservés (les autres sont écartés : cookies, jetons, en-têtes de cache et de serveur). */
  keepHeaders?: string[];
}

export interface GenerateResult {
  mocks: MockDefinition[];
  written: string[];
  skipped: { reason: string; count: number }[];
  redactions: number;
}

export const DEFAULT_REDACT = /(token|password|passwd|secret|authorization|api[-_]?key|cookie|session|jwt)/i;
const DEFAULT_KEEP = ['content-type', 'content-language', 'content-disposition', 'location'];
const STATIC_TYPES = /^(text\/html|text\/css|image\/|font\/|application\/(javascript|x-javascript|font)|text\/javascript)/i;
const API_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^\d+$/;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/** `/api/cases/42/notes/7` donne `/api/cases/:id/notes/:id2`. */
export function templateOf(pathname: string): string {
  let n = 0;
  return pathname
    .split('/')
    .map((segment) => {
      if (segment && (UUID.test(segment) || NUMBER.test(segment) || LONG_HEX.test(segment))) {
        n += 1;
        return n === 1 ? ':id' : `:id${n}`;
      }
      return segment;
    })
    .join('/');
}

export function slug(method: string, template: string): string {
  const body = template.replace(/^\/+|\/+$/g, '').replace(/:/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${method.toUpperCase()}_${body || 'root'}`;
}

function redact(value: unknown, pattern: RegExp, counter: { n: number }): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, pattern, counter));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        if (pattern.test(k) && (typeof v === 'string' || typeof v === 'number')) {
          counter.n += 1;
          return [k, '[REDACTED]'];
        }
        return [k, redact(v, pattern, counter)];
      }),
    );
  }
  return value;
}

function isApi(entry: HarEntry, mime: string): boolean {
  if (entry._resourceType) return API_RESOURCE_TYPES.has(entry._resourceType);
  return !STATIC_TYPES.test(mime);
}

function decode(content: NonNullable<HarEntry['response']['content']>): { text?: string; base64?: string } {
  if (content.text === undefined) return {};
  return content.encoding === 'base64' ? { base64: content.text } : { text: content.text };
}

export function mocksFromHar(har: Har, options: GenerateOptions = {}): Omit<GenerateResult, 'written'> {
  const pick = options.pick ?? 'last';
  const redactPattern = options.redactKeys === undefined ? DEFAULT_REDACT : options.redactKeys;
  const keep = new Set((options.keepHeaders ?? DEFAULT_KEEP).map((h) => h.toLowerCase()));
  const counter = { n: 0 };
  const skipped = new Map<string, number>();
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);

  const groups = new Map<string, HarEntry[]>();
  for (const entry of har.log.entries) {
    const url = entry.request.url;
    if (entry.response.status === 0) { skip('réponse absente (requête annulée ou bloquée)'); continue; }
    if (options.include && !options.include.some((r) => r.test(url))) { skip('hors du filtre --include'); continue; }
    if (options.exclude?.some((r) => r.test(url))) { skip('écarté par --exclude'); continue; }
    if (!/^https?:/i.test(url)) { skip('URL non HTTP (data:, blob:)'); continue; }
    const mime = entry.response.content?.mimeType ?? '';
    if ((options.apiOnly ?? true) && !isApi(entry, mime)) { skip('ressource statique'); continue; }

    const key = `${entry.request.method.toUpperCase()} ${templateOf(new URL(url).pathname)}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  const mocks: MockDefinition[] = [];
  for (const [key, entries] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [method = 'GET', template = '/'] = key.split(' ') as [string, string];
    const chosen = pick === 'first' ? entries[0]! : entries[entries.length - 1]!;
    const response = chosen.response;
    const mime = response.content?.mimeType ?? '';
    const headers = Object.fromEntries(
      (response.headers ?? []).filter((h) => keep.has(h.name.toLowerCase())).map((h) => [h.name.toLowerCase(), h.value] as const),
    );
    const mock: MockDefinition = {
      id: slug(method, template),
      method,
      pathTemplate: template,
      status: response.status,
      headers,
      ...(mime ? { contentType: mime.split(';')[0]!.trim() } : {}),
      source: { url: chosen.request.url, ...(chosen.startedDateTime ? { startedAt: chosen.startedDateTime } : {}), recordedCalls: entries.length },
    };

    if (response.content) {
      const { text, base64 } = decode(response.content);
      if (base64 !== undefined) mock.bodyBase64 = base64;
      else if (text !== undefined) {
        if (/json/i.test(mime)) {
          try {
            const parsed = JSON.parse(text) as unknown;
            mock.body = redactPattern ? redact(parsed, redactPattern, counter) : parsed;
          } catch {
            mock.bodyText = text;
          }
        } else {
          mock.bodyText = text;
        }
      }
    }

    const statuses = [...new Set(entries.map((e) => e.response.status))];
    if (statuses.length > 1) {
      mock.notes = [`Statuts vus pour cette route : ${statuses.join(', ')} (gardé : ${response.status}, option --pick ${pick}).`];
    }
    mocks.push(mock);
  }

  return {
    mocks,
    skipped: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
    redactions: counter.n,
  };
}

/** Lit un fichier HAR, écrit un fichier JSON par route dans `outDir` et un `index.json`. */
export function generateMocks(harPath: string, outDir: string, options: GenerateOptions = {}): GenerateResult {
  const har = JSON.parse(fs.readFileSync(harPath, 'utf8')) as Har;
  if (!har?.log?.entries) throw new Error(`${harPath} n'est pas un fichier HAR (log.entries manquant)`);
  const result = mocksFromHar(har, options);

  fs.mkdirSync(outDir, { recursive: true });
  // Une régénération repart d'un dossier propre : on retire les fichiers listés par l'index précédent.
  const indexFile = path.join(outDir, 'index.json');
  if (fs.existsSync(indexFile)) {
    const previous = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as { mocks?: { file: string }[] };
    for (const m of previous.mocks ?? []) fs.rmSync(path.join(outDir, path.basename(m.file)), { force: true });
  }

  const written: string[] = [];
  for (const mock of result.mocks) {
    const file = path.join(outDir, `${mock.id}.json`);
    fs.writeFileSync(file, `${JSON.stringify(mock, null, 2)}\n`);
    written.push(file);
  }
  fs.writeFileSync(indexFile, `${JSON.stringify({ generatedFrom: path.basename(harPath), mocks: result.mocks.map((m) => ({ id: m.id, method: m.method, path: m.pathTemplate, status: m.status, file: `${m.id}.json` })) }, null, 2)}\n`);
  written.push(indexFile);
  return { ...result, written };
}
