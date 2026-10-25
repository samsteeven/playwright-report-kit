import path from 'node:path';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import { errorText, findRequirements, findXrayKey, summarizeTotals, toPosix } from './model';
import type { Annotation, AttachmentInfo, RunSummary, TestRecord, TestStatus } from './model';

function statusOf(test: TestCase): TestStatus {
  switch (test.outcome()) {
    case 'expected':
      return 'passed';
    case 'flaky':
      return 'flaky';
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** Étiquettes d'un test : `test.tags` (Playwright 1.42+), sinon les `@mots` du titre. */
function tagsOf(test: TestCase): string[] {
  const declared = (test as TestCase & { tags?: string[] }).tags;
  if (Array.isArray(declared)) return [...declared];
  return [...test.title.matchAll(/(?:^|\s)(@[\w-]+)/g)].map((m) => m[1] ?? '');
}

function attachmentsOf(results: TestResult[]): AttachmentInfo[] {
  // Les pièces jointes des tentatives réussies précédentes ne servent à rien : on garde celles de la dernière tentative.
  const last = results[results.length - 1];
  if (!last) return [];
  return last.attachments.map((a) => ({
    name: a.name,
    contentType: a.contentType,
    ...(a.path ? { path: a.path } : {}),
    ...(a.body ? { body: a.body } : {}),
  }));
}

/**
 * Dossier de référence pour les chemins : celui de la configuration Playwright. `config.rootDir` vaut le dossier des
 * tests (`testDir`), ce qui donnerait `auth.spec.ts` au lieu de `e2e/specs/auth.spec.ts`.
 */
export function baseDirOf(config: FullConfig): string {
  return config.configFile ? path.dirname(config.configFile) : config.rootDir;
}

export function recordOf(test: TestCase, rootDir: string): TestRecord {
  const results = test.results;
  const titlePath = test.titlePath();
  // titlePath = ['', projet, fichier, ...describe, titre]
  const suites = titlePath.slice(3, -1);
  const annotations: Annotation[] = test.annotations.map((a) => ({
    type: a.type,
    ...(a.description !== undefined ? { description: a.description } : {}),
  }));
  const tags = tagsOf(test);
  const startedAt = results[0]?.startTime ?? new Date();
  const durationMs = results.reduce((sum, r) => sum + r.duration, 0);
  const last = results[results.length - 1];
  const status = statusOf(test);
  const xrayKey = findXrayKey(annotations, tags, test.title);

  return {
    id: test.id,
    file: toPosix(path.relative(rootDir, test.location.file)),
    suites,
    title: test.title,
    fullTitle: [...suites, test.title].join(' › '),
    project: test.parent.project()?.name ?? '',
    status,
    durationMs,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date(startedAt.getTime() + durationMs).toISOString(),
    attempts: results.map((r) => ({
      retry: r.retry,
      status: r.status,
      durationMs: r.duration,
      startedAt: r.startTime.toISOString(),
      errors: r.errors.map(errorText),
    })),
    errors: status === 'failed' && last ? last.errors.map(errorText) : [],
    attachments: attachmentsOf(results),
    tags,
    annotations,
    ...(xrayKey ? { xrayKey } : {}),
    requirements: findRequirements(annotations),
  };
}

export interface CollectInput {
  title: string;
  config: FullConfig;
  suite: Suite;
  result: FullResult;
  startedAt: Date;
  environment: Record<string, string>;
}

export function collectSummary(input: CollectInput): RunSummary {
  const tests = input.suite.allTests().map((t) => recordOf(t, baseDirOf(input.config)));
  const finishedAt = new Date();
  return {
    title: input.title,
    status: input.result.status === 'timedout' ? 'timedout' : input.result.status === 'interrupted' ? 'interrupted' : input.result.status === 'passed' ? 'passed' : 'failed',
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: input.result.duration,
    totals: summarizeTotals(tests),
    tests,
    environment: input.environment,
  };
}
