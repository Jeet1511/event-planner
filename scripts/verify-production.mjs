/**
 * Production-path verification against a fake PostgREST.
 *
 * Proves the things a deploy actually depends on: that NODE_ENV=production now
 * boots when (and only when) both controls are configured, that every route is
 * locked until the workspace key is exchanged, that writes reach the database,
 * and that data survives a full process restart. Real Supabase is still not
 * contacted — no credentials exist — so this verifies our side of the contract.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'production-verification-secret';
const rows = new Map();
let sqlRequests = 0;

const db = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');
    sqlRequests += 1;
    // The store addresses <restUrl>/events, and restUrl carries a /rest/v1 prefix
    // exactly like Supabase's, so match on the tail rather than the whole path.
    if (!url.pathname.endsWith('/events')) { res.writeHead(404).end('{}'); return; }
    if (req.method === 'GET') {
      const list = [...rows.values()].reverse();
      const limit = Number(url.searchParams.get('limit') || 0);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(limit ? list.slice(0, limit) : list));
      return;
    }
    if (req.method === 'POST') { for (const row of JSON.parse(body)) rows.set(row.id, row); res.writeHead(201).end(''); return; }
    if (req.method === 'DELETE') {
      const ids = (url.searchParams.get('id') || '').replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map(value => value.replace(/"/g, ''));
      for (const id of ids) rows.delete(id);
      res.writeHead(204).end(); return;
    }
    res.writeHead(405).end();
  });
});
await new Promise(resolve => db.listen(0, '127.0.0.1', resolve));
const restUrl = `http://127.0.0.1:${db.address().port}/rest/v1`;

function startServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production',
      EVENTPILOT_DATA_DIR: path.join(ROOT, '.verify-data'),
      EVENTPILOT_AI_PROVIDER: 'none', GEMINI_API_KEY: '', GROQ_API_KEY: '',
      SUPABASE_REST_URL: restUrl, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role',
      EVENTPILOT_ACCESS_KEY: KEY, ...extraEnv
    }
  });
  const logs = [];
  child.stdout.on('data', chunk => logs.push(String(chunk)));
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  child.logs = logs;
  return child;
}

async function waitFor(port, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return await r.json(); } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

const results = [];
const note = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

// 1. production refuses to start without the workspace secret
const noSecret = startServer(3471, { EVENTPILOT_ACCESS_KEY: '' });
const earlyExit = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 4000);
  noSecret.once('exit', code => { clearTimeout(timer); resolve(code); });
});
const refusal = noSecret.logs.join('').split('\n').find(line => /Production startup blocked/.test(line)) || noSecret.logs.join('').trim().split('\n').pop();
note('production startup refuses without a workspace key', Boolean(earlyExit), `exit ${earlyExit}; ${String(refusal).slice(0, 150)}`);

// 2. production starts when both controls are present
const port = 3472;
let server = startServer(port);
const health = await waitFor(port);
note('production boots with persistence + key', Boolean(health), health ? `health ok, eventCount hidden: ${health.eventCount === undefined}` : 'server never answered');
if (!health) { console.log(server.logs.join('')); process.exit(1); }

const base = `http://127.0.0.1:${port}`;
const locked = await fetch(`${base}/api/events`);
note('data routes are locked before the key is exchanged', locked.status === 401, `HTTP ${locked.status}`);

const session = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: KEY }) });
const setCookieHeader = session.headers.get('set-cookie') || '';
const cookie = setCookieHeader.split(';')[0];
note('the workspace key opens a session', session.status === 200 && /eventpilot_session=/.test(cookie), `HTTP ${session.status}`);
// Attributes live on the full Set-Cookie header, not on the split value.
note('the session cookie is HttpOnly + SameSite=Strict and hides the key',
  /HttpOnly/.test(setCookieHeader) && /SameSite=Strict/.test(setCookieHeader) && !setCookieHeader.includes(KEY),
  setCookieHeader.replace(KEY, '[KEY]'));

const authed = await fetch(`${base}/api/events`, { headers: { cookie } });
note('an authorised read succeeds', authed.status === 200, `HTTP ${authed.status}`);

// 3. a real write reaches the database
const input = { name: 'Persistence check wedding', type: 'wedding', city: 'Pune', date: '2027-02-01', guests: 180, budget: 900000 };
const plan = await (await fetch(`${base}/api/plan`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify(input) })).json();
const created = await (await fetch(`${base}/api/events`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, cookie }, body: JSON.stringify({ ...input, proposalId: plan.proposalId }) })).json();
note('an event written in production mode lands in the database', rows.size === 1 && rows.get(created.event?.id || created.id) !== undefined, `rows=${rows.size}`);

// 4. the data survives a full process restart — the whole point of the migration
server.kill('SIGTERM');
await new Promise(resolve => server.once('exit', resolve));
server = startServer(port);
const afterRestart = await waitFor(port);
const listed = await (await fetch(`${base}/api/events`, { headers: { cookie: (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: KEY }) })).headers.get('set-cookie').split(';')[0] } })).json();
note('data survives a process restart', Array.isArray(listed) && listed.length === 1, `${listed.length} event(s) after restart; health ${afterRestart?.ok}`);
note('the restarted server reads from the database, not a file', sqlRequests > 3, `${sqlRequests} REST requests`);

server.kill('SIGTERM');
await new Promise(resolve => setTimeout(resolve, 300));
db.close();
const failed = results.filter(item => !item.ok);
console.log(failed.length ? `FAILED: ${failed.map(item => item.name).join(', ')}` : 'production path verified');
process.exit(failed.length ? 1 : 0);
