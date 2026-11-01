/**
 * The Supabase PostgREST store, verified against a local fake PostgREST.
 *
 * Same method as test/gemini.test.mjs: the wire contract is exercised against a
 * server that behaves like the real one, so request shape, auth headers,
 * diffing and error mapping are all checked here. What this CANNOT prove is that
 * a real Supabase project accepts this schema — that needs credentials, and is
 * recorded as unverified rather than claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDbStore, normalizeRestUrl } from '../src/db-store.mjs';

function fakePostgREST() {
  const rows = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, path: url.pathname + url.search, headers: req.headers, body: body || null });
      if (url.pathname !== '/events') { res.writeHead(404).end('{"message":"not found"}'); return; }
      if (req.method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || 0);
        const list = [...rows.values()].reverse();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(limit ? list.slice(0, limit) : list));
      }
      if (req.method === 'POST') {
        for (const row of JSON.parse(body)) rows.set(row.id, row);
        res.writeHead(201).end('');
        return;
      }
      if (req.method === 'DELETE') {
        const ids = (url.searchParams.get('id') || '').replace(/^in\.\(/, '').replace(/\)$/, '').split(',').map(value => value.replace(/"/g, ''));
        for (const id of ids) rows.delete(id);
        res.writeHead(204).end('');
        return;
      }
      res.writeHead(405).end('');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server, rows, seen,
    restUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => server.close(done))
  })));
}

const event = (id, title = 'Ananya wedding') => ({ id, name: title, budget: 800000, tasks: [], categories: [], conversation: [] });

test('the store reads events and remembers what it loaded', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  fake.rows.set('a', { id: 'a', data: event('a') });
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'a');
  const calls = fake.seen.filter(call => call.method === 'GET').length;
  await store.load();
  assert.equal(fake.seen.filter(call => call.method === 'GET').length, calls, 'a second read must be served from cache');
});

test('the service key is sent as both apikey and bearer, and never in the URL', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'secret-role-key' });
  await store.load();
  const call = fake.seen[0];
  assert.equal(call.headers.apikey, 'secret-role-key');
  assert.equal(call.headers.authorization, 'Bearer secret-role-key');
  assert.ok(!call.path.includes('secret-role-key'), 'credentials must not travel in the query string');
});

test('a mutation writes only the row that changed', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  await store.withEvents(events => events.push(event('a'), event('b')));
  const writes = fake.seen.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].body).length, 2, 'first write creates both rows');
  assert.equal(writes[0].headers.prefer, 'resolution=merge-duplicates,return=minimal');
  assert.match(writes[0].path, /on_conflict=id/);

  await store.withEvents(events => { events.find(item => item.id === 'b').name = 'Renamed'; });
  const second = fake.seen.filter(call => call.method === 'POST').at(-1);
  const payload = JSON.parse(second.body);
  assert.equal(payload.length, 1, 'only the changed event is written again');
  assert.equal(payload[0].id, 'b');
  assert.ok(payload[0].updated_at, 'the row records when it changed');
  assert.equal(fake.rows.get('a').data.name, 'Ananya wedding');
  assert.equal(fake.rows.get('b').data.name, 'Renamed');
});

test('deleting an event removes its row and nothing else', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  await store.withEvents(events => events.push(event('a'), event('b'), event('c')));
  await store.withEvents(events => events.splice(1, 1));
  const removed = [...fake.rows.keys()];
  assert.deepEqual(removed, ['a', 'c']);
});

test('an unchanged aggregate writes nothing at all', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  await store.withEvents(events => events.push(event('a')));
  const before = fake.seen.filter(call => call.method === 'POST').length;
  await store.withEvents(events => events);
  assert.equal(fake.seen.filter(call => call.method === 'POST').length, before, 'a no-op mutation must not hit the database');
});

test('a failed write is surfaced, not swallowed', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  await store.load();
  const failing = createDbStore({
    restUrl: fake.restUrl,
    restKey: 'test-key',
    fetchImpl: (url, init) => (init?.method === 'POST'
      ? Promise.resolve(new Response('{"message":"row-level security"}', { status: 403 }))
      : fetch(url, init))
  });
  await assert.rejects(
    () => failing.withEvents(events => events.push(event('z'))),
    /HTTP 403.*row-level security|row-level security.*HTTP 403|Database request failed \(HTTP 403\)/
  );
});

test('the health ping reaches the table', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  assert.deepEqual(await store.ping(), { ok: true, table: 'events' });
  assert.match(fake.seen.at(-1).path, /limit=1/);
});

test('a plain http endpoint is refused unless it is local', () => {
  assert.throws(() => normalizeRestUrl('http://evil.example.com/rest/v1'), /must use https/);
  assert.throws(() => normalizeRestUrl('not-a-url'), /not a valid URL/);
  assert.equal(normalizeRestUrl('https://project.supabase.co/rest/v1/'), 'https://project.supabase.co/rest/v1');
  assert.equal(normalizeRestUrl('http://127.0.0.1:54321/rest/v1'), 'http://127.0.0.1:54321/rest/v1');
});

test('the store refuses to start without both halves of its configuration', () => {
  assert.throws(() => createDbStore({ restUrl: 'https://x.supabase.co/rest/v1' }), /restUrl and restKey/);
  assert.throws(() => createDbStore({ restKey: 'k' }), /restUrl and restKey/);
});

test('writes are serialised, so concurrent mutations cannot lose each other', async t => {
  const fake = await fakePostgREST();
  t.after(() => fake.close());
  const store = createDbStore({ restUrl: fake.restUrl, restKey: 'test-key' });
  await Promise.all([
    store.withEvents(events => events.push(event('one'))),
    store.withEvents(events => events.push(event('two'))),
    store.withEvents(events => events.push(event('three')))
  ]);
  assert.deepEqual([...fake.rows.keys()].sort(), ['one', 'three', 'two']);
});
