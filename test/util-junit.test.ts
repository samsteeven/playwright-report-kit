import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';
import { renderJUnit, uniqueNames } from '../src/junit';
import { findRequirements, findXrayKey } from '../src/model';
import { escapeXml, formatDuration, stripAnsi, truncate } from '../src/util';
import { record, summary } from './helpers';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', isArray: (name) => ['testsuite', 'testcase', 'property'].includes(name) });
const parse = (xml: string) => parser.parse(xml) as { testsuites: { testsuite: Array<{ '@_name': string; testcase: Array<Record<string, any>> }> } & Record<string, string> };

describe('utilitaires', () => {
  it('retire les couleurs ANSI de Playwright', () => {
    expect(stripAnsi('\u001b[31mErreur\u001b[39m : \u001b[2mattendu\u001b[22m')).toBe('Erreur : attendu');
  });

  it('échappe le XML et retire les caractères de contrôle interdits', () => {
    expect(escapeXml(`a<b>&"c"'d'\u0000\u0007\u001b`)).toBe('a&lt;b&gt;&amp;&quot;c&quot;&apos;d&apos;');
    expect(escapeXml('accentué ✓ 😀')).toBe('accentué ✓ 😀');
  });

  it('formate les durées', () => {
    expect(formatDuration(480)).toBe('480 ms');
    expect(formatDuration(1234)).toBe('1,2 s');
    expect(formatDuration(125_000)).toBe('2 min 05 s');
  });

  it('coupe les textes trop longs avec une ellipse', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('clés Xray', () => {
  it('lit la clé dans une annotation, une étiquette ou le titre', () => {
    expect(findXrayKey([{ type: 'xray', description: 'TJ-12' }], [], 'x')).toBe('TJ-12');
    expect(findXrayKey([{ type: 'test_key', description: 'TJ-13' }], [], 'x')).toBe('TJ-13');
    expect(findXrayKey([], ['@TJ-14'], 'x')).toBe('TJ-14');
    expect(findXrayKey([], [], 'connexion @TJ-15 réussie')).toBe('TJ-15');
  });

  it('ignore ce qui ne ressemble pas à une clé Jira', () => {
    expect(findXrayKey([{ type: 'xray', description: 'tj-12' }], ['@smoke'], 'titre @abc')).toBeUndefined();
  });

  it('lit les exigences, séparées par des virgules', () => {
    expect(findRequirements([{ type: 'requirement', description: 'TJ-1, TJ-2,nope' }])).toEqual(['TJ-1', 'TJ-2']);
  });
});

describe('export JUnit pour Xray', () => {
  const tests = [
    record({ id: 'a', title: 'se connecte', xrayKey: 'TJ-12', tags: ['@smoke', '@TJ-12'], requirements: ['TJ-1'] }),
    record({ id: 'b', title: 'refuse un mot de passe faux', status: 'failed', errors: ['Expected: "<ok>" & plus\nReceived: "ko"'], durationMs: 3400 }),
    record({ id: 'c', title: 'sauté', status: 'skipped', durationMs: 0 }),
    record({ id: 'd', title: 'instable', status: 'flaky', attempts: [
      { retry: 0, status: 'failed', durationMs: 100, startedAt: 'x', errors: ['boom'] },
      { retry: 1, status: 'passed', durationMs: 100, startedAt: 'x', errors: [] },
    ] }),
  ];

  it('produit un XML bien formé avec les bons compteurs', () => {
    const doc = parse(renderJUnit(summary(tests), { xray: true }));
    expect(doc.testsuites['@_tests']).toBe('4');
    expect(doc.testsuites['@_failures']).toBe('1');
    expect(doc.testsuites['@_skipped']).toBe('1');
    expect(doc.testsuites.testsuite).toHaveLength(1);
    expect(doc.testsuites.testsuite[0]!.testcase).toHaveLength(4);
  });

  it('ajoute test_key, requirements, tags et le commentaire d\'exécution', () => {
    const [first, failed, , flaky] = parse(renderJUnit(summary(tests), { xray: true })).testsuites.testsuite[0]!.testcase;
    const props = (tc: Record<string, any>) => Object.fromEntries(tc.properties.property.map((p: any) => [p['@_name'], p['@_value']]));
    expect(props(first!)).toMatchObject({ test_key: 'TJ-12', test_summary: 'se connecte', requirements: 'TJ-1', tags: 'smoke' });
    expect(props(failed!)['testrun_comment']).toContain('Expected');
    expect(props(flaky!)['testrun_comment']).toContain('1 relance');
  });

  it('échappe le contenu des échecs sans casser le XML', () => {
    const xml = renderJUnit(summary(tests), { xray: true });
    expect(xml).toContain('Expected: &quot;&lt;ok&gt;&quot; &amp; plus');
    const failure = parse(xml).testsuites.testsuite[0]!.testcase[1]!['failure'];
    expect(String(failure['#text'] ?? failure)).toContain('<ok>');
  });

  it('marque les tests ignorés', () => {
    expect(renderJUnit(summary(tests), { xray: true })).toMatch(/<skipped\/>/);
  });

  it('sans l\'option xray, reste un JUnit standard', () => {
    const xml = renderJUnit(summary(tests), { xray: false });
    expect(xml).not.toContain('<properties>');
    expect(xml).not.toContain('started-at');
  });

  it('rend les noms uniques quand deux tests portent le même titre', () => {
    const dup = [record({ id: '1', title: 'même titre' }), record({ id: '2', title: 'même titre' }), record({ id: '3', title: 'même titre', project: 'firefox' })];
    const names = [...uniqueNames(dup).values()];
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toContain('[chromium]');
    expect(names[2]).toContain('[firefox]');
  });
});
