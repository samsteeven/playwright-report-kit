// Récepteur local qui joue le rôle du flux Power Automate (« Quand une requête de webhook Teams est reçue »).
// Il accepte la carte adaptative, la garde sur disque et répond 202 comme le déclencheur. Il ne prouve PAS que
// Teams affichera la carte : il prouve que le message envoyé a la forme attendue.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createTeamsSink({ outDir } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end('JSON invalide'); return; }
      const card = payload?.attachments?.[0];
      if (payload?.type !== 'message' || card?.contentType !== 'application/vnd.microsoft.card.adaptive') {
        res.writeHead(400).end('attendu : { type: "message", attachments: [carte adaptative] }');
        return;
      }
      received.push(payload);
      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, `card-${received.length}.json`), JSON.stringify(payload, null, 2));
      }
      res.writeHead(202).end();
    });
  });
  return { server, received };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4500);
  const { server, received } = createTeamsSink({ outDir: process.env.TEAMS_SINK_OUT ?? 'report-kit/teams-sink' });
  server.on('request', () => setTimeout(() => {
    const body = received.at(-1)?.attachments?.[0]?.content?.body?.[0]?.text;
    if (body) console.log(`Carte reçue : ${body}`);
  }, 20));
  server.listen(port, '127.0.0.1', () => console.log(`Récepteur Teams sur http://127.0.0.1:${port}/webhook`));
}
