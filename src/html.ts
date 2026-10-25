import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, formatDuration, toPosix } from './util';
import type { AttachmentInfo, RunSummary, TestRecord, TestStatus } from './model';

export interface HtmlOptions {
  /** Dossier où le rapport est écrit : sert à calculer les liens relatifs vers les vidéos et les traces. */
  reportDir: string;
  /** Taille maximale d'une capture intégrée au fichier (au-delà, un lien relatif). */
  maxEmbedBytes?: number;
}

const LABEL: Record<TestStatus, string> = { passed: 'Réussi', failed: 'Échec', flaky: 'Instable', skipped: 'Ignoré' };
const ICON: Record<TestStatus, string> = { passed: '✓', failed: '✕', flaky: '↻', skipped: '–' };

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--text:#1b1f24;--muted:#5b6470;--line:#dfe3e8;--ok:#1a7f4b;--ok-bg:#e4f5ec;--ko:#b42318;--ko-bg:#fdeceb;--flaky:#8a5a00;--flaky-bg:#fdf2d9;--skip:#5b6470;--skip-bg:#eceff3;--accent:#2457c5}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--panel:#1d2127;--text:#e8eaed;--muted:#9aa4b0;--line:#2e343c;--ok:#5fd38f;--ok-bg:#12301f;--ko:#ff8a80;--ko-bg:#3a1a18;--flaky:#f2c14e;--flaky-bg:#3a2d0e;--skip:#9aa4b0;--skip-bg:#252a31;--accent:#8ab4ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
h1{margin:0 0 4px;font-size:1.5rem}h2{font-size:1.05rem;margin:28px 0 10px}
.meta{color:var(--muted);font-size:.9rem;display:flex;flex-wrap:wrap;gap:4px 16px}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:1px 10px;font-size:.8rem;font-weight:600;white-space:nowrap}
.passed{background:var(--ok-bg);color:var(--ok)}.failed{background:var(--ko-bg);color:var(--ko)}.flaky{background:var(--flaky-bg);color:var(--flaky)}.skipped{background:var(--skip-bg);color:var(--skip)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:18px 0 10px}
.tile{all:unset;box-sizing:border-box;cursor:pointer;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.tile:focus-visible,.tile[aria-pressed=true]{outline:2px solid var(--accent)}
.tile b{display:block;font-size:1.6rem;line-height:1.2}.tile span{color:var(--muted);font-size:.85rem}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--skip-bg);margin:4px 0 14px}
.bar i{display:block}.bar .passed{background:var(--ok)}.bar .failed{background:var(--ko)}.bar .flaky{background:var(--flaky)}.bar .skipped{background:var(--skip)}
.search{width:100%;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td,th{padding:7px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:.9rem}tr:last-child td{border-bottom:0}th{color:var(--muted);font-weight:600}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
details.file{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:10px 0}
details.file>summary{cursor:pointer;padding:10px 14px;font-weight:600;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
details.file>summary small{color:var(--muted);font-weight:400}
.test{border-top:1px solid var(--line)}.test>summary{cursor:pointer;padding:8px 14px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.test .title{flex:1 1 320px}.test .dur{color:var(--muted);font-variant-numeric:tabular-nums;font-size:.85rem}
.chip{background:var(--skip-bg);color:var(--muted);border-radius:6px;padding:0 6px;font-size:.78rem}.chip.key{color:var(--accent);font-weight:600}
.detail{padding:4px 14px 14px 14px;font-size:.9rem}.detail h3{font-size:.85rem;margin:12px 0 4px;color:var(--muted)}
pre{margin:0;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:12.5px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
.shot{max-width:100%;border:1px solid var(--line);border-radius:8px;margin-top:6px}
.hidden{display:none}.empty{color:var(--muted);padding:18px;text-align:center}
`;

const JS = `
(function(){
  var tests=[].slice.call(document.querySelectorAll('.test'));
  var files=[].slice.call(document.querySelectorAll('details.file'));
  var tiles=[].slice.call(document.querySelectorAll('.tile'));
  var search=document.getElementById('q');
  var empty=document.getElementById('empty');
  var status='all';
  function apply(){
    var q=search.value.trim().toLowerCase();
    var visible=0;
    tests.forEach(function(t){
      var ok=(status==='all'||t.dataset.status===status)&&(!q||t.dataset.text.indexOf(q)!==-1);
      t.classList.toggle('hidden',!ok); if(ok)visible++;
    });
    files.forEach(function(f){ f.classList.toggle('hidden',!f.querySelector('.test:not(.hidden)')); });
    empty.classList.toggle('hidden',visible>0);
  }
  tiles.forEach(function(b){ b.addEventListener('click',function(){
    status=b.dataset.filter===status?'all':b.dataset.filter;
    tiles.forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.filter===status));});
    apply();
  });});
  search.addEventListener('input',apply);
})();
`;

function embed(a: AttachmentInfo, opts: Required<HtmlOptions>): string | undefined {
  if (!a.contentType.startsWith('image/')) return undefined;
  try {
    const data = a.body ?? (a.path ? fs.readFileSync(a.path) : undefined);
    if (!data || data.length > opts.maxEmbedBytes) return undefined;
    return `data:${a.contentType};base64,${data.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function attachmentHtml(a: AttachmentInfo, opts: Required<HtmlOptions>): string {
  const name = escapeHtml(a.name);
  const uri = embed(a, opts);
  if (uri) return `<div><img class="shot" alt="${name}" src="${uri}"><div class="dur">${name}</div></div>`;
  if (a.path) {
    const href = toPosix(path.relative(opts.reportDir, a.path)).split('/').map(encodeURIComponent).join('/');
    return `<div><a href="${href}">${name}</a> <span class="dur">(${escapeHtml(a.contentType)})</span></div>`;
  }
  return `<div>${name} <span class="dur">(${escapeHtml(a.contentType)}, non enregistré sur disque)</span></div>`;
}

function testHtml(t: TestRecord, opts: Required<HtmlOptions>): string {
  const chips = [
    ...(t.xrayKey ? [`<span class="chip key" title="Test Xray">${escapeHtml(t.xrayKey)}</span>`] : []),
    ...t.tags.filter((x) => x.replace(/^@/, '') !== t.xrayKey).map((x) => `<span class="chip">${escapeHtml(x)}</span>`),
    ...(t.attempts.length > 1 ? [`<span class="chip">${t.attempts.length} tentatives</span>`] : []),
  ].join(' ');

  const sections: string[] = [];
  if (t.errors.length > 0) {
    sections.push(`<h3>Erreur</h3>${t.errors.map((e) => `<pre>${escapeHtml(e)}</pre>`).join('')}`);
  }
  if (t.status === 'flaky') {
    const failedTries = t.attempts.filter((a) => a.errors.length > 0);
    sections.push(`<h3>Tentatives en échec avant la réussite</h3>${failedTries.map((a) => `<pre>Tentative ${a.retry + 1} : ${escapeHtml(a.errors.join('\n\n'))}</pre>`).join('')}`);
  }
  if (t.requirements.length > 0) {
    sections.push(`<h3>Exigences</h3><div>${t.requirements.map((r) => `<span class="chip key">${escapeHtml(r)}</span>`).join(' ')}</div>`);
  }
  if (t.attachments.length > 0) {
    sections.push(`<h3>Pièces jointes</h3>${t.attachments.map((a) => attachmentHtml(a, opts)).join('')}`);
  }
  const text = `${t.fullTitle} ${t.file} ${t.xrayKey ?? ''} ${t.tags.join(' ')}`.toLowerCase();
  const open = t.status === 'failed' || t.status === 'flaky' ? ' open' : '';
  const body = sections.length > 0 ? `<div class="detail">${sections.join('')}</div>` : '';
  return `<details class="test" data-status="${t.status}" data-text="${escapeHtml(text)}"${open}><summary>` +
    `<span class="badge ${t.status}"><span aria-hidden="true">${ICON[t.status]}</span>${LABEL[t.status]}</span>` +
    `<span class="title">${escapeHtml(t.fullTitle)}</span>${chips}<span class="dur">${formatDuration(t.durationMs)}</span></summary>${body}</details>`;
}

export function renderHtml(summary: RunSummary, options: HtmlOptions): string {
  const opts: Required<HtmlOptions> = { maxEmbedBytes: 400 * 1024, ...options };
  const { totals } = summary;
  const percent = (n: number) => (totals.total === 0 ? 0 : (n / totals.total) * 100).toFixed(2);

  const byFile = new Map<string, TestRecord[]>();
  for (const t of summary.tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
  const files = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));

  const slowest = [...summary.tests].filter((t) => t.status !== 'skipped').sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

  const tile = (key: string, label: string, n: number) =>
    `<button class="tile" type="button" data-filter="${key}" aria-pressed="false"><b>${n}</b><span>${label}</span></button>`;

  const fileBlocks = files.map(([file, tests]) => {
    const counts = (['passed', 'failed', 'flaky', 'skipped'] as const)
      .map((s) => [s, tests.filter((t) => t.status === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `<span class="badge ${s}">${n} ${LABEL[s].toLowerCase()}</span>`)
      .join(' ');
    const open = tests.some((t) => t.status === 'failed' || t.status === 'flaky') ? ' open' : '';
    return `<details class="file"${open}><summary>${escapeHtml(file)} ${counts}</summary>${tests.map((t) => testHtml(t, opts)).join('')}</details>`;
  });

  const env = Object.entries(summary.environment).map(([k, v]) => `<span>${escapeHtml(k)} : ${escapeHtml(v)}</span>`).join('');
  const overall = summary.status === 'passed' && totals.failed === 0 ? 'passed' : 'failed';
  const date = new Date(summary.startedAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'medium' });

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(summary.title)} : rapport de tests</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>${escapeHtml(summary.title)}</h1>
<div class="meta"><span class="badge ${overall}">${overall === 'passed' ? 'Succès' : 'Échec'}</span><span>${escapeHtml(date)}</span><span>Durée : ${formatDuration(summary.durationMs)}</span>${env}</div>
<div class="tiles">${tile('all', 'Tests', totals.total)}${tile('passed', 'Réussis', totals.passed)}${tile('failed', 'En échec', totals.failed)}${tile('flaky', 'Instables', totals.flaky)}${tile('skipped', 'Ignorés', totals.skipped)}</div>
<div class="bar" role="img" aria-label="${totals.passed} réussis, ${totals.failed} en échec, ${totals.flaky} instables, ${totals.skipped} ignorés"><i class="passed" style="width:${percent(totals.passed)}%"></i><i class="flaky" style="width:${percent(totals.flaky)}%"></i><i class="failed" style="width:${percent(totals.failed)}%"></i><i class="skipped" style="width:${percent(totals.skipped)}%"></i></div>
<input id="q" class="search" type="search" placeholder="Filtrer par titre, fichier, clé Xray ou étiquette" aria-label="Filtrer les tests">
${slowest.length > 0 ? `<h2>Les 5 tests les plus lents</h2><table><thead><tr><th>Test</th><th>Fichier</th><th class="num">Durée</th></tr></thead><tbody>${slowest.map((t) => `<tr><td>${escapeHtml(t.fullTitle)}</td><td>${escapeHtml(t.file)}</td><td class="num">${formatDuration(t.durationMs)}</td></tr>`).join('')}</tbody></table>` : ''}
<h2>Tests par fichier</h2>
${fileBlocks.join('\n')}
<p id="empty" class="empty hidden">Aucun test ne correspond au filtre.</p>
</main>
<script>${JS}</script>
</body>
</html>
`;
}
