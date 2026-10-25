import { formatDuration, truncate } from './util';
import type { FetchLike } from './xray';
import type { RunSummary } from './model';

export type NotifyMode = 'always' | 'failure' | 'never';

export interface TeamsOptions {
  /** Adresse du déclencheur « Quand une requête de webhook Teams est reçue » du flux Power Automate. */
  webhookUrl: string;
  notify: NotifyMode;
  /** Lien vers le rapport publié (artefact de CI, page web) : ajoute un bouton à la carte. */
  reportUrl?: string;
  /** Nombre maximum de tests en échec détaillés dans la carte. */
  maxFailures?: number;
}

/** Les cartes Teams sont limitées à environ 28 Ko : on garde une marge. */
const MAX_PAYLOAD_BYTES = 24_000;

interface AdaptiveCard {
  $schema: string;
  type: 'AdaptiveCard';
  version: string;
  msteams: { width: 'Full' };
  body: unknown[];
  actions?: unknown[];
}

export function shouldNotify(mode: NotifyMode, summary: RunSummary): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return summary.totals.failed > 0 || summary.status !== 'passed';
}

export function buildCard(summary: RunSummary, options: Pick<TeamsOptions, 'reportUrl' | 'maxFailures'>, failuresShown?: number): AdaptiveCard {
  const { totals } = summary;
  const ok = summary.status === 'passed' && totals.failed === 0;
  const max = failuresShown ?? options.maxFailures ?? 5;
  const failing = summary.tests.filter((t) => t.status === 'failed');

  const body: unknown[] = [
    {
      type: 'TextBlock',
      text: `${ok ? '✅' : '❌'} ${summary.title} : ${ok ? 'tous les tests passent' : `${totals.failed} test(s) en échec`}`,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: ok ? 'Good' : 'Attention',
    },
    {
      type: 'FactSet',
      facts: [
        { title: 'Tests', value: String(totals.total) },
        { title: 'Réussis', value: String(totals.passed) },
        { title: 'En échec', value: String(totals.failed) },
        { title: 'Instables', value: String(totals.flaky) },
        { title: 'Ignorés', value: String(totals.skipped) },
        { title: 'Durée', value: formatDuration(summary.durationMs) },
      ],
    },
  ];

  if (failing.length > 0 && max > 0) {
    body.push({ type: 'TextBlock', text: 'Premiers échecs', weight: 'Bolder', spacing: 'Medium' });
    for (const t of failing.slice(0, max)) {
      const firstLine = (t.errors[0] ?? '').split('\n')[0] ?? '';
      body.push({
        type: 'TextBlock',
        text: `**${truncate(t.fullTitle, 120)}** (${t.file})\n\n${truncate(firstLine, 200)}`,
        wrap: true,
        spacing: 'Small',
      });
    }
    if (failing.length > max) {
      body.push({ type: 'TextBlock', text: `… et ${failing.length - max} autre(s)`, isSubtle: true, spacing: 'Small' });
    }
  }

  const card: AdaptiveCard = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    msteams: { width: 'Full' },
    body,
  };
  if (options.reportUrl) card.actions = [{ type: 'Action.OpenUrl', title: 'Ouvrir le rapport', url: options.reportUrl }];
  return card;
}

/** Enveloppe attendue par le déclencheur de webhook de Power Automate : un message portant une carte adaptative. */
export function buildPayload(summary: RunSummary, options: Pick<TeamsOptions, 'reportUrl' | 'maxFailures'>) {
  let shown = options.maxFailures ?? 5;
  for (;;) {
    const payload = {
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: buildCard(summary, options, shown) }],
    };
    if (shown === 0 || Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES) return payload;
    shown = Math.max(0, Math.floor(shown / 2));
  }
}

export async function postToTeams(webhookUrl: string, payload: unknown, doFetch: FetchLike = fetch): Promise<void> {
  const response = await doFetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });
  // Power Automate répond 202 (accepté) ; un flux désactivé ou supprimé répond 4xx.
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Teams a refusé la notification (HTTP ${response.status}) : ${truncate(text, 200)}`);
  }
}

export function teamsFromEnv(env: NodeJS.ProcessEnv = process.env): TeamsOptions | undefined {
  const webhookUrl = env['TEAMS_WEBHOOK_URL'];
  if (!webhookUrl) return undefined;
  const notify = (env['PRK_NOTIFY'] ?? 'failure') as NotifyMode;
  return {
    webhookUrl,
    notify: ['always', 'failure', 'never'].includes(notify) ? notify : 'failure',
    ...(env['PRK_REPORT_URL'] ? { reportUrl: env['PRK_REPORT_URL'] } : {}),
  };
}
