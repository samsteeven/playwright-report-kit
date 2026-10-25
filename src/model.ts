import { stripAnsi, toPosix } from './util';

export type TestStatus = 'passed' | 'failed' | 'flaky' | 'skipped';

export interface AttachmentInfo {
  name: string;
  contentType: string;
  /** Chemin du fichier sur disque (captures, vidéos, traces). */
  path?: string;
  /** Contenu en mémoire quand Playwright ne l'a pas écrit sur disque. */
  body?: Buffer;
}

export interface AttemptInfo {
  retry: number;
  /** Statut Playwright de cette tentative : passed, failed, timedOut, skipped, interrupted. */
  status: string;
  durationMs: number;
  startedAt: string;
  errors: string[];
}

export interface Annotation {
  type: string;
  description?: string;
}

export interface TestRecord {
  id: string;
  /** Fichier de spec, relatif à la racine du projet, avec des barres obliques. */
  file: string;
  /** Titres des `describe` qui englobent le test. */
  suites: string[];
  title: string;
  /** `suites › title`, nom lisible et unique dans le fichier. */
  fullTitle: string;
  project: string;
  status: TestStatus;
  /** Somme de toutes les tentatives (une relance coûte du temps réel). */
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  attempts: AttemptInfo[];
  errors: string[];
  attachments: AttachmentInfo[];
  tags: string[];
  annotations: Annotation[];
  /** Clé du test dans Xray (par exemple `TJ-12`), si le test en déclare une. */
  xrayKey?: string;
  requirements: string[];
}

export interface Totals {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

export interface RunSummary {
  title: string;
  /** Statut global rendu par Playwright. */
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: Totals;
  tests: TestRecord[];
  environment: Record<string, string>;
}

/** Clé de ticket Jira : lettres majuscules, tiret, nombre (`TJ-12`, `PROJ2-345`). */
export const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

/** Cherche une clé Xray dans les annotations (`xray` ou `test_key`), les étiquettes ou le titre (`@TJ-12`). */
export function findXrayKey(annotations: Annotation[], tags: string[], title: string): string | undefined {
  for (const a of annotations) {
    if ((a.type === 'xray' || a.type === 'test_key') && a.description && ISSUE_KEY.test(a.description.trim())) {
      return a.description.trim();
    }
  }
  const candidates = [...tags.map((t) => t.replace(/^@/, '')), ...[...title.matchAll(/@([A-Z][A-Z0-9]+-\d+)/g)].map((m) => m[1] ?? '')];
  return candidates.find((c) => ISSUE_KEY.test(c));
}

export function findRequirements(annotations: Annotation[]): string[] {
  return annotations
    .filter((a) => a.type === 'requirement' && a.description)
    .flatMap((a) => (a.description ?? '').split(','))
    .map((s) => s.trim())
    .filter((s) => ISSUE_KEY.test(s));
}

export function summarizeTotals(tests: TestRecord[]): Totals {
  const count = (status: TestStatus) => tests.filter((t) => t.status === status).length;
  return { total: tests.length, passed: count('passed'), failed: count('failed'), flaky: count('flaky'), skipped: count('skipped') };
}

/** Message d'erreur lisible : sans couleurs ANSI, avec l'extrait de code quand Playwright le fournit. */
export function errorText(error: { message?: string; value?: string; snippet?: string }): string {
  const parts = [error.message ?? error.value ?? 'Erreur sans message', error.snippet].filter((p): p is string => Boolean(p));
  return stripAnsi(parts.join('\n\n')).trim();
}

export { toPosix };
