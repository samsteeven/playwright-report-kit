import type { RunSummary, TestRecord } from '../src/model';
import { summarizeTotals } from '../src/model';

export function record(overrides: Partial<TestRecord> = {}): TestRecord {
  const title = overrides.title ?? 'se connecte';
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    file: 'e2e/auth.spec.ts',
    suites: [],
    title,
    fullTitle: overrides.fullTitle ?? title,
    project: 'chromium',
    status: 'passed',
    durationMs: 1200,
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:00:01.200Z',
    attempts: [{ retry: 0, status: 'passed', durationMs: 1200, startedAt: '2026-10-26T10:00:00.000Z', errors: [] }],
    errors: [],
    attachments: [],
    tags: [],
    annotations: [],
    requirements: [],
    ...overrides,
  };
}

export function summary(tests: TestRecord[], overrides: Partial<RunSummary> = {}): RunSummary {
  const totals = summarizeTotals(tests);
  return {
    title: 'Parcours TribuneJustice',
    status: totals.failed > 0 ? 'failed' : 'passed',
    startedAt: '2026-10-26T10:00:00.000Z',
    finishedAt: '2026-10-26T10:02:05.000Z',
    durationMs: 125_000,
    totals,
    tests,
    environment: { Playwright: '1.64.1', Node: 'v24.0.0' },
    ...overrides,
  };
}
