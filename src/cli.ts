#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { generateMocks } from './har/generate';
import type { GenerateOptions } from './har/generate';
import { uploadJUnit, xrayFromEnv } from './xray';

const HELP = `prk : outils du dépôt playwright-report-kit

Utilisation :
  prk har-mocks <fichier.har> --out <dossier> [options]
      Génère un fichier JSON par route d'API à partir d'un enregistrement HAR.
      --include <regex>      ne garde que les URL qui correspondent (répétable)
      --exclude <regex>      écarte les URL qui correspondent (répétable)
      --all                  garde aussi les ressources statiques (pages, scripts, images)
      --pick first|last      réponse gardée quand une route est appelée plusieurs fois (défaut : last)
      --redact-keys <regex>  clés JSON à masquer (défaut : token, password, secret, authorization, api key, cookie, session)
      --no-redact            ne masque rien

  prk xray-upload <junit.xml>
      Envoie un fichier JUnit existant à Xray. Variables : XRAY_PROJECT_KEY, XRAY_CLIENT_ID, XRAY_CLIENT_SECRET,
      XRAY_BASE_URL (défaut : Xray Cloud), XRAY_TEST_EXEC_KEY, XRAY_TEST_PLAN_KEY.
`;

function fail(message: string): never {
  console.error(`prk : ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'har-mocks') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        all: { type: 'boolean' },
        pick: { type: 'string' },
        'redact-keys': { type: 'string' },
        'no-redact': { type: 'boolean' },
      },
    });
    const [har] = positionals;
    if (!har) fail('fichier HAR manquant (prk har-mocks <fichier.har> --out <dossier>)');
    if (!values.out) fail('option --out manquante');
    if (values.pick && values.pick !== 'first' && values.pick !== 'last') fail('--pick vaut first ou last');

    const options: GenerateOptions = {
      ...(values.include ? { include: values.include.map((r) => new RegExp(r)) } : {}),
      ...(values.exclude ? { exclude: values.exclude.map((r) => new RegExp(r)) } : {}),
      ...(values.all ? { apiOnly: false } : {}),
      ...(values.pick ? { pick: values.pick as 'first' | 'last' } : {}),
      ...(values['no-redact'] ? { redactKeys: false as const } : values['redact-keys'] ? { redactKeys: new RegExp(values['redact-keys'], 'i') } : {}),
    };
    const result = generateMocks(har, values.out, options);
    console.log(`${result.mocks.length} route(s) écrites dans ${values.out}`);
    for (const m of result.mocks) console.log(`  ${m.method.padEnd(6)} ${m.pathTemplate}  ->  ${m.status}  (${m.source.recordedCalls} appel(s) enregistré(s))`);
    for (const s of result.skipped) console.log(`  ignoré : ${s.count} × ${s.reason}`);
    if (result.redactions > 0) console.log(`  ${result.redactions} valeur(s) masquée(s) ([REDACTED])`);
    return;
  }

  if (command === 'xray-upload') {
    const [file] = rest;
    if (!file) fail('fichier JUnit manquant (prk xray-upload <junit.xml>)');
    const xray = xrayFromEnv();
    if (!xray) fail('variables XRAY_PROJECT_KEY, XRAY_CLIENT_ID et XRAY_CLIENT_SECRET requises');
    const result = await uploadJUnit(fs.readFileSync(file, 'utf8'), xray);
    console.log(`Importé dans Xray : exécution ${result.key}`);
    return;
  }

  fail(`commande inconnue : ${command}\n\n${HELP}`);
}

main().catch((error: Error) => fail(error.message));
