/**
 * Workspace access control, exercised over real HTTP against the real app.
 *
 * These tests exist because the alternative was shipping a build that refuses
 * production startup: once a deployment CAN come up publicly, someone has to
 * prove it is not an open database of other people's weddings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { createMockProvider } from '../src/ai-providers.mjs';

const KEY = 'workspace-secret-value-1234';

async function keyedApp(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eventpilot-keyed-'));
  const provider = createMockProvider({ responses: [] });
  const app = createApp({ dataDir: dir, ai: { provider }, accessKey: KEY });
  const address = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  try { return await run({ base, app, provider }); } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const get = (base, url, options = {}) => fetch(base + url, options);

test('every data route is refused without a session', async t => {
  await keyedApp(async ({ base }) => {
    for (const url of ['/api/events', '/api/events/00000000-0000-0000-0000-000000000000', '/api/plan', '/api/ai/consult']) {
      const response = await get(base, url, { method: url === '/api/events' ? 'GET' : 'POST', headers: url === '/api/events' ? {} : { 'content-type': 'application/json', origin: base }, body: url === '/api/events' ? undefined : '{}' });
      assert.equal(response.status, 401, `${url} must not answer without a session`);
      const body = await response.json();
      assert.equal(body.keepExistingData, true);
      assert.match(body.error, /workspace is locked/i);
    }
  });
});

test('health stays reachable for platform probes but stops describing the workspace', async t => {
  await keyedApp(async ({ base }) => {
    const response = await get(base, '/api/health');
    assert.equal(response.status, 200, 'a health check that needs a key breaks the deploy');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.eventCount, undefined, 'eventCount would leak how much is stored');
  });
});

test('the correct key opens a session and the cookie carries it', async t => {
  await keyedApp(async ({ base }) => {
    const wrong = await get(base, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: 'guess' }) });
    assert.equal(wrong.status, 401);

    const ok = await get(base, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: KEY }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /eventpilot_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=/, 'the session must expire rather than live forever');
    assert.ok(!cookie.includes(KEY), 'the workspace key itself must never reach the browser');

    const list = await get(base, '/api/events', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), []);
  });
});

test('a bearer token with the key works, and a forged cookie does not', async t => {
  await keyedApp(async ({ base }) => {
    const bearer = await get(base, '/api/events', { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(bearer.status, 200);

    // Same shape as a real token, different nonce: the signature has to fail.
    const forged = 'deadbeefdeadbeefdeadbeefdeadbeef.' + '0'.repeat(64);
    const rejected = await get(base, '/api/events', { headers: { cookie: `eventpilot_session=${forged}` } });
    assert.equal(rejected.status, 401);
  });
});

test('signing out revokes the token, not just the browser copy', async t => {
  await keyedApp(async ({ base }) => {
    const login = await get(base, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: KEY }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await get(base, '/api/events', { headers: { cookie } })).status, 200);
    const out = await get(base, '/api/session', { method: 'DELETE', headers: { 'content-type': 'application/json', origin: base, cookie }, body: '{}' });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    // A stateless signed token would still verify here; the server remembers the
    // revoked nonce precisely so "sign out" is not decorative.
    assert.equal((await get(base, '/api/events', { headers: { cookie } })).status, 401);
  });
});

test('key attempts are rate limited so the secret cannot be brute-forced quickly', async t => {
  await keyedApp(async ({ base }) => {
    const statuses = [];
    for (let i = 0; i < 9; i += 1) {
      const response = await get(base, '/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ key: `guess-${i}` }) });
      statuses.push(response.status);
    }
    assert.ok(statuses.includes(429), `expected a rate-limit refusal among ${statuses.join(',')}`);
    assert.ok(statuses.slice(0, 5).every(status => status === 401), 'the first attempts must fail on the secret, not on the limit');
  });
});

test('an unkeyed local demo still answers everything (no regression for development)', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eventpilot-open-'));
  const app = createApp({ dataDir: dir, ai: { provider: createMockProvider({ responses: [] }) } });
  const address = await app.listen(0, '127.0.0.1');
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/events`);
  assert.equal(response.status, 200);
});
