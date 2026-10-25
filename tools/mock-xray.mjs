// Faux serveur Xray Cloud, pour la démonstration et les tests. Il imite DEUX appels de l'API REST v2 :
//   POST /api/v2/authenticate                      (client_id, client_secret) -> "jeton"
//   POST /api/v2/import/execution/junit?projectKey= (Content-Type text/xml, Authorization: Bearer)
// Il ne valide PAS le XML comme le vrai Xray (pas de création de tests ni de liaison aux tickets Jira) :
// il compte les cas de test reçus et les clés `test_key`, et garde le fichier reçu.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function createMockXray({ clientId = 'demo-id', clientSecret = 'demo-secret', outDir } = {}) {
  const tokens = new Set();
  const imports = [];
  let sequence = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status, payload, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      if (req.method === 'POST' && url.pathname === '/api/v2/authenticate') {
        let creds = {};
        try { creds = JSON.parse(body); } catch { return send(400, 'wrong request syntax', 'text/plain'); }
        if (creds.client_id !== clientId || creds.client_secret !== clientSecret) return send(401, 'Authentication failed', 'text/plain');
        const token = `mock-${Math.random().toString(36).slice(2)}`;
        tokens.add(token);
        return send(200, JSON.stringify(token)); // une chaîne JSON entre guillemets, comme le vrai Xray
      }

      if (req.method === 'POST' && url.pathname === '/api/v2/import/execution/junit') {
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!tokens.has(token)) return send(401, 'Invalid token', 'text/plain');
        const projectKey = url.searchParams.get('projectKey');
        if (!projectKey) return send(400, { error: 'projectKey is required' });
        if (!/^text\/xml/i.test(req.headers['content-type'] ?? '')) return send(400, { error: 'Content-Type must be text/xml' });
        if (!body.includes('<testcase')) return send(400, { error: 'no testcase found in the JUnit file' });

        sequence += 1;
        const record = {
          key: url.searchParams.get('testExecKey') ?? `${projectKey}-${100 + sequence}`,
          id: String(10000 + sequence),
          projectKey,
          testcases: (body.match(/<testcase\b/g) ?? []).length,
          linkedToKey: (body.match(/<property name="test_key"/g) ?? []).length,
          failures: (body.match(/<failure\b/g) ?? []).length,
          skipped: (body.match(/<skipped\b/g) ?? []).length,
          bytes: Buffer.byteLength(body),
          receivedAt: new Date().toISOString(),
        };
        imports.push(record);
        if (outDir) {
          fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, `import-${sequence}.xml`), body);
          fs.writeFileSync(path.join(outDir, `import-${sequence}.json`), JSON.stringify(record, null, 2));
        }
        return send(200, { id: record.id, key: record.key, self: `${url.origin}/rest/api/2/issue/${record.id}` });
      }

      if (req.method === 'GET' && url.pathname === '/_imports') return send(200, imports);
      send(404, { error: 'not found' });
    });
  });
  return { server, imports };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4400);
  const { server } = createMockXray({ outDir: process.env.MOCK_XRAY_OUT ?? 'report-kit/mock-xray' });
  server.listen(port, '127.0.0.1', () => console.log(`Faux Xray sur http://127.0.0.1:${port} (identifiants : demo-id / demo-secret)`));
}
