import { escapeXml, truncate } from './util';
import type { RunSummary, TestRecord } from './model';

export interface JUnitOptions {
  /**
   * Ajoute les propriétés comprises par l'import JUnit de Xray (`test_key`, `test_summary`, `requirements`, `tags`,
   * `testrun_comment`). Sans elles, le fichier reste un JUnit standard.
   */
  xray: boolean;
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/**
 * Xray crée ou retrouve un test à partir de `classname` + `name` : ils doivent être uniques dans l'exécution.
 * Deux tests de même nom (même fichier, deux projets) reçoivent le nom du projet puis un numéro.
 */
export function uniqueNames(tests: TestRecord[]): Map<string, string> {
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  const multiProject = new Set(tests.map((t) => t.project)).size > 1;
  for (const t of tests) {
    const base = multiProject && t.project ? `[${t.project}] ${t.fullTitle}` : t.fullTitle;
    const key = `${t.file}::${base}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    names.set(t.id, n === 1 ? base : `${base} (#${n})`);
  }
  return names;
}

function property(name: string, value: string): string {
  return `        <property name="${escapeXml(name)}" value="${escapeXml(value)}"/>`;
}

function testcaseXml(t: TestRecord, name: string, options: JUnitOptions): string {
  const props: string[] = [];
  if (options.xray) {
    if (t.xrayKey) props.push(property('test_key', t.xrayKey));
    props.push(property('test_summary', t.title));
    if (t.requirements.length > 0) props.push(property('requirements', t.requirements.join(',')));
    const tags = t.tags.map((x) => x.replace(/^@/, '')).filter((x) => x !== t.xrayKey);
    if (tags.length > 0) props.push(property('tags', tags.join(',')));
    if (t.status === 'flaky') {
      props.push(property('testrun_comment', `Instable : réussi après ${t.attempts.length - 1} relance(s).`));
    } else if (t.status === 'failed') {
      props.push(property('testrun_comment', truncate(t.errors[0] ?? 'Échec', 500)));
    }
  }

  const attrs = `classname="${escapeXml(t.file)}" name="${escapeXml(name)}" time="${seconds(t.durationMs)}"` +
    (options.xray ? ` started-at="${t.startedAt}" finished-at="${t.finishedAt}"` : '');

  let body = '';
  if (props.length > 0) body += `      <properties>\n${props.join('\n')}\n      </properties>\n`;
  if (t.status === 'failed') {
    const message = truncate((t.errors[0] ?? 'Échec').split('\n')[0] ?? 'Échec', 300);
    body += `      <failure message="${escapeXml(message)}" type="AssertionError">${escapeXml(t.errors.join('\n\n'))}</failure>\n`;
  } else if (t.status === 'skipped') {
    body += '      <skipped/>\n';
  }
  return body ? `    <testcase ${attrs}>\n${body}    </testcase>` : `    <testcase ${attrs}/>`;
}

/** JUnit XML d'une exécution : une `testsuite` par fichier de spec, comme le fait le reporter JUnit de Playwright. */
export function renderJUnit(summary: RunSummary, options: JUnitOptions): string {
  const names = uniqueNames(summary.tests);
  const byFile = new Map<string, TestRecord[]>();
  for (const t of summary.tests) {
    const list = byFile.get(t.file) ?? [];
    list.push(t);
    byFile.set(t.file, list);
  }

  const suites = [...byFile.entries()].map(([file, tests]) => {
    const failures = tests.filter((t) => t.status === 'failed').length;
    const skipped = tests.filter((t) => t.status === 'skipped').length;
    const time = tests.reduce((s, t) => s + t.durationMs, 0);
    const cases = tests.map((t) => testcaseXml(t, names.get(t.id) ?? t.fullTitle, options)).join('\n');
    return `  <testsuite name="${escapeXml(file)}" tests="${tests.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${seconds(time)}" timestamp="${tests[0]?.startedAt ?? summary.startedAt}">\n${cases}\n  </testsuite>`;
  });

  const { total, failed, skipped } = summary.totals;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${escapeXml(summary.title)}" tests="${total}" failures="${failed}" errors="0" skipped="${skipped}" time="${seconds(summary.durationMs)}">\n${suites.join('\n')}\n</testsuites>\n`;
}
