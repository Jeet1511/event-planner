// Render-shaped environment checks: 0.0.0.0 bind under production, and the
// X-Forwarded-Proto path that decides whether the session cookie is marked
// Secure. Both are silent-kill failure modes on a real PaaS.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'render-environment-check-secret';
const rows = new Map();
const db = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.endsWith('/events')) { res.writeHead(404).end('{}'); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([...rows.values()])); return; }
    if (req.method === 'POST') { for (const r of JSON.parse(body)) rows.set(r.id, r); res.writeHead(201).end(''); return; }
    res.writeHead(204).end();
  });
});
await new Promise(r => db.listen(0, '127.0.0.1', r));

const port = 3478;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env, PORT: String(port), HOST: '0.0.0.0', NODE_ENV: 'production',
    EVENTPILOT_DATA_DIR: path.join(ROOT, '.verify-data-render'),
    EVENTPILOT_AI_PROVIDER: 'none', GEMINI_API_KEY: '', GROQ_API_KEY: '',
    SUPABASE_REST_URL: `http://127.0.0.1:${db.address().port}/rest/v1`,
    SUPABASE_SERVICE_ROLE_KEY: 'fake', EVENTPILOT_ACCESS_KEY: KEY
  }
});
const logs = [];
child.stdout.on('data', c => logs.push(String(c)));
child.stderr.on('data', c => logs.push(String(c)));

const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) fails.push(name); };

let health = null;
for (let i = 0; i < 45 && !health; i += 1) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) health = await r.json(); } catch { await new Promise(r => setTimeout(r, 150)); }
}
check('binds 0.0.0.0 in production when configured', Boolean(health), logs.join('').trim().split('\n').slice(0, 2).join(' | '));

// Behind Render's proxy the browser talks https; the app sees http + a header.
const viaProxy = await fetch(`http://127.0.0.1:${port}/api/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'eventpilot.onrender.com' },
  body: JSON.stringify({ key: KEY })
});
const setCookie = viaProxy.headers.get('set-cookie') || '';
check('proxied https request issues a Secure cookie', /Secure/.test(setCookie), setCookie.replace(KEY, '[KEY]').slice(0, 160));
check('proxied https session still authenticates', viaProxy.status === 200);

// A plain http request (local dev) must NOT get a Secure cookie, or it breaks locally.
const plain = await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ key: KEY }) });
check('plain http request does not get a Secure cookie', !/Secure/.test(plain.headers.get('set-cookie') || ''), (plain.headers.get('set-cookie') || '').slice(0, 120));

// Origin guard must survive the proxy: Render forwards the real Origin header.
const wrongOrigin = await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', host: 'eventpilot.onrender.com' }, body: JSON.stringify({ key: KEY }) });
check('cross-origin write is still refused behind a proxy', wrongOrigin.status === 403, `HTTP ${wrongOrigin.status}`);

child.kill('SIGTERM');
db.close();
await new Promise(r => setTimeout(r, 250));
console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'render-environment checks passed');
process.exit(fails.length ? 1 : 0);
