// Mini-application de démonstration : un formulaire de contact et trois routes d'API, sans dépendance.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOPICS = [
  { id: 1, label: 'Question générale' },
  { id: 2, label: 'Problème de paiement' },
  { id: 3, label: 'Demande de rendez-vous' },
];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createApp() {
  const messages = new Map();
  let sequence = 0;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(here, 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/topics') return json(200, TOPICS);

    if (req.method === 'POST' && url.pathname === '/api/contact') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400, { error: 'JSON invalide' }); }
        const errors = {};
        if (!body.name || String(body.name).trim().length < 2) errors.name = 'Indiquez votre nom (2 caractères minimum).';
        if (!EMAIL.test(String(body.email ?? ''))) errors.email = 'Adresse e-mail invalide.';
        if (!TOPICS.some((t) => t.id === Number(body.topic))) errors.topic = 'Choisissez un thème.';
        if (!body.message || String(body.message).trim().length < 10) errors.message = 'Le message doit contenir 10 caractères minimum.';
        if (body.consent !== true) errors.consent = 'Vous devez accepter le traitement de votre message.';
        if (Object.keys(errors).length > 0) return json(422, { errors });

        sequence += 1;
        const id = sequence;
        messages.set(id, { id, ...body });
        // `accessToken` ressemble à un jeton de session : il sert à montrer le masquage lors de la génération des mocks.
        return json(201, { id, reference: `CT-${String(id).padStart(4, '0')}`, accessToken: `tok_${Math.random().toString(36).slice(2)}` });
      });
      return;
    }

    const match = /^\/api\/contact\/(\d+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) {
      const found = messages.get(Number(match[1]));
      return found ? json(200, { id: found.id, reference: `CT-${String(found.id).padStart(4, '0')}`, status: 'reçu' }) : json(404, { error: 'introuvable' });
    }
    json(404, { error: 'introuvable' });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4310);
  createApp().listen(port, '127.0.0.1', () => console.log(`Démo sur http://127.0.0.1:${port}`));
}
