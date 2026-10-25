import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';
import { baseDirOf, collectSummary } from './collect';
import { renderHtml } from './html';
import { renderJUnit } from './junit';
import type { RunSummary } from './model';
import { buildPayload, postToTeams, shouldNotify, teamsFromEnv } from './teams';
import type { TeamsOptions } from './teams';
import { formatDuration } from './util';
import { uploadJUnit, xrayFromEnv } from './xray';
import type { XrayOptions } from './xray';

export interface ReporterOptions {
  /** Titre du rapport (défaut : `PRK_TITLE` ou « Rapport de tests Playwright »). */
  title?: string;
  /** Dossier de sortie, relatif au dossier de la configuration Playwright (défaut : `PRK_OUTPUT_DIR` ou `report-kit`). */
  outputDir?: string;
  /** Rapport HTML autonome (défaut : activé). */
  html?: boolean | { fileName?: string; maxEmbedBytes?: number };
  /** Export JUnit XML (défaut : activé, avec les propriétés Xray). */
  junit?: boolean | { fileName?: string; xray?: boolean };
  /** Import des résultats dans Xray ; `false` pour le désactiver. Défaut : lu dans les variables `XRAY_*`. */
  xray?: XrayOptions | false;
  /** Notification Teams ; `false` pour la désactiver. Défaut : lue dans `TEAMS_WEBHOOK_URL`. */
  teams?: TeamsOptions | false;
}

const PREFIX = '[report-kit]';

export default class ReportKitReporter implements Reporter {
  private config?: FullConfig;
  private suite?: Suite;
  private startedAt = new Date();

  constructor(private readonly options: ReporterOptions = {}) {}

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
    this.startedAt = new Date();
  }

  async onEnd(result: FullResult): Promise<void> {
    if (!this.config || !this.suite) return;
    const config = this.config;
    const outputDir = path.resolve(baseDirOf(config), this.options.outputDir ?? process.env['PRK_OUTPUT_DIR'] ?? 'report-kit');
    fs.mkdirSync(outputDir, { recursive: true });

    const summary = collectSummary({
      title: this.options.title ?? process.env['PRK_TITLE'] ?? 'Rapport de tests Playwright',
      config,
      suite: this.suite,
      result,
      startedAt: this.startedAt,
      environment: {
        Playwright: config.version,
        Node: process.version,
        Système: `${os.platform()} ${os.release()}`,
        Workers: String(config.workers),
      },
    });

    // Les fichiers sont écrits d'abord : un échec d'Xray ou de Teams ne doit jamais faire perdre le rapport.
    const written = this.writeFiles(summary, outputDir);
    console.log(
      `${PREFIX} ${summary.totals.total} tests en ${formatDuration(summary.durationMs)} : ${summary.totals.passed} réussis, ` +
        `${summary.totals.failed} en échec, ${summary.totals.flaky} instables, ${summary.totals.skipped} ignorés`,
    );
    for (const file of written.files) console.log(`${PREFIX}   ${path.relative(process.cwd(), file) || file}`);

    await this.upload(summary, written.junitXml, outputDir);
    await this.notify(summary);
  }

  private writeFiles(summary: RunSummary, outputDir: string): { files: string[]; junitXml?: string } {
    const files: string[] = [];
    let junitXml: string | undefined;

    const html = this.options.html ?? true;
    if (html) {
      const cfg = typeof html === 'object' ? html : {};
      const file = path.join(outputDir, cfg.fileName ?? 'report.html');
      fs.writeFileSync(file, renderHtml(summary, { reportDir: outputDir, ...(cfg.maxEmbedBytes ? { maxEmbedBytes: cfg.maxEmbedBytes } : {}) }));
      files.push(file);
    }

    const junit = this.options.junit ?? true;
    if (junit) {
      const cfg = typeof junit === 'object' ? junit : {};
      const file = path.join(outputDir, cfg.fileName ?? 'junit.xml');
      junitXml = renderJUnit(summary, { xray: cfg.xray ?? true });
      fs.writeFileSync(file, junitXml);
      files.push(file);
    }

    // Résumé lisible par une machine, sans les pièces jointes : les chiffres du README viennent de là.
    const json = path.join(outputDir, 'summary.json');
    const slim = { ...summary, tests: summary.tests.map(({ attachments, ...rest }) => ({ ...rest, attachments: attachments.map((a) => ({ name: a.name, contentType: a.contentType })) })) };
    fs.writeFileSync(json, JSON.stringify(slim, null, 2));
    files.push(json);
    return { files, junitXml };
  }

  private async upload(summary: RunSummary, junitXml: string | undefined, outputDir: string): Promise<void> {
    const xray = this.options.xray === false ? undefined : (this.options.xray ?? xrayFromEnv());
    if (!xray) return;
    if (!junitXml) {
      console.warn(`${PREFIX} Xray : export JUnit désactivé, rien à envoyer`);
      return;
    }
    try {
      const result = await uploadJUnit(junitXml, xray);
      const withKey = summary.tests.filter((t) => t.xrayKey).length;
      console.log(`${PREFIX} Xray : ${summary.totals.total} résultats envoyés (${withKey} avec une clé de test), exécution ${result.key}`);
      fs.writeFileSync(path.join(outputDir, 'xray-result.json'), JSON.stringify({ ...result, tests: summary.totals.total, linkedToKey: withKey }, null, 2));
    } catch (error) {
      console.warn(`${PREFIX} Xray : envoi impossible (${(error as Error).message}). Les fichiers locaux sont intacts.`);
    }
  }

  private async notify(summary: RunSummary): Promise<void> {
    const teams = this.options.teams === false ? undefined : (this.options.teams ?? teamsFromEnv());
    if (!teams || !shouldNotify(teams.notify, summary)) return;
    try {
      await postToTeams(teams.webhookUrl, buildPayload(summary, teams));
      console.log(`${PREFIX} Teams : notification envoyée`);
    } catch (error) {
      console.warn(`${PREFIX} Teams : notification impossible (${(error as Error).message})`);
    }
  }
}
