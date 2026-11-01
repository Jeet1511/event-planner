import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { createApp } from '../server.mjs';
import { createMockProvider } from '../src/ai-providers.mjs';

/**
 * Performance regression gates. The targets are the numbers measured during the
 * v2 optimisation pass; they exist so a later change cannot quietly re-introduce
 * a 600 KB list response, an uncompressed bundle or a stale read cache.
 *
 * `fetch` decompresses transparently and therefore cannot measure wire bytes,
 * so this file reads raw http responses on purpose.
 */
async function seededApp(eventCount = 40) {
  const dir = await mkdtemp(path.join(tmpdir(), 'eventpilot-perf-'));
  const list = [];
  for (let index = 0; index < eventCount; index += 1) {
    const categories = ['Venue', 'Catering'].map(name => ({ id: randomUUID(), name, allocation: 100000, source: 'template' }));
    list.push({
      id: randomUUID(), name: `Event ${index}`, type: 'wedding', city: 'Kolkata', date: '2027-02-01',
      guestsCount: 250, budget: 800000, currency: 'INR', categories,
      tasks: Array.from({ length: 14 }, (_, t) => ({ id: randomUUID(), title: `Task ${t}-${index}`, description: 'x'.repeat(140), dueDate: '2026-12-01', priority: 'high', status: t % 3 === 0 ? 'completed' : 'pending', source: 'template' })),
      ideas: [], scheduleWarnings: [], strategy: { overview: 'o'.repeat(200), concept: 'c', theme: 't', priorities: [], challenges: [], recommendations: [] },
      vendorRequirements: [], risks: [], assumptions: [], missingInformation: [], aiSuggestions: 's'.repeat(500),
      aiProposal: { strategy: {}, budgetCategories: [], tasks: [], ideas: [], vendorRequirements: [], risks: [] },
      planSource: 'ai-suggestion',
      guests: Array.from({ length: 25 }, (_, g) => ({ id: randomUUID(), name: `G${g}`, contact: '99', rsvp: 'accepted' })),
      vendors: [],
      expenses: Array.from({ length: 6 }, () => ({ id: randomUUID(), description: 'e', amount: 1000, categoryId: categories[0].id, date: '2026-06-01', idempotencyKey: randomUUID() })),
      quotations: [],
      conversation: Array.from({ length: 20 }, () => ({ id: randomUUID(), role: 'assistant', content: 'c'.repeat(400), createdAt: '2026-11-01T00:00:00.000Z' })),
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z'
    });
  }
  await writeFileAsync(path.join(dir, 'events.json'), JSON.stringify(list, null, 2));
  const provider = createMockProvider({ responses: [] });
  const app = createApp({ dataDir: dir, ai: { provider } });
  const address = await app.listen(0, '127.0.0.1');
  return { app, base: `http://127.0.0.1:${address.port}`, dir, provider, first: list[0] };
}

function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const wire = Buffer.concat(chunks);
        const encoding = response.headers['content-encoding'];
        let body = wire;
        if (encoding === 'gzip') body = gunzipSync(wire);
        else if (encoding === 'br') body = brotliDecompressSync(wire);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          bytes: wire.length,
          decodedBytes: body.length,
          json: response.headers['content-type']?.includes('json') ? JSON.parse(body.toString()) : null,
          text: body.toString(),
          ms: performance.now() - started
        });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

test('the events list is a projected payload, not the whole workspace', async t => {
  const { app, base, dir } = await seededApp();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const compressed = await rawGet(`${base}/api/events`, { 'accept-encoding': 'gzip' });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.equal(compressed.headers.vary, 'Accept-Encoding');
  const list = compressed.json;
  assert.equal(list.length, 40);
  const event = list[0];
  for (const heavy of ['tasks', 'conversation', 'aiProposal', 'aiSuggestions', 'guests', 'expenses', 'strategy', 'risks', 'vendors', 'quotations']) {
    assert.ok(!(heavy in event), `list payload must not carry ${heavy}`);
  }
  for (const needed of ['id', 'name', 'type', 'city', 'date', 'budget', 'taskCount', 'tasksCompleted', 'planHealth', 'summary', 'planSource']) {
    assert.ok(needed in event, `list payload must carry ${needed}`);
  }
  assert.equal(event.taskCount, 14);
  assert.equal(event.tasksCompleted, 5);
  assert.equal(event.summary.spent, 6000);
  const identity = await rawGet(`${base}/api/events`);
  assert.equal(identity.headers['content-encoding'], undefined, 'clients without Accept-Encoding get identity');
  assert.ok(compressed.bytes < 40_000, `gzipped list should be under 40 KB on the wire, got ${compressed.bytes}`);
  assert.ok(compressed.bytes < identity.decodedBytes / 4, `compression ratio weaker than the measured 5.7x bound: ${identity.decodedBytes} → ${compressed.bytes}`);
});

test('list latency stays bounded at 40 events and cached reads see writes', async t => {
  const { app, base, dir } = await seededApp();
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const samples = [];
  for (let index = 0; index < 20; index += 1) samples.push((await rawGet(`${base}/api/events`, { 'accept-encoding': 'gzip' })).ms);
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  assert.ok(p95 < 60, `p95 was ${p95.toFixed(1)}ms for 40 events`);
  const before = (await rawGet(`${base}/api/events`)).json[0];
  const written = await fetch(`${base}/api/events/${before.id}/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Cache probe task' })
  });
  assert.equal(written.status, 201);
  await written.json();
  const after = (await rawGet(`${base}/api/events`)).json[0];
  assert.equal(after.taskCount, before.taskCount + 1, 'the read cache must be invalidated by a write');
});

test('static assets are compressed once and revalidated with an ETag', async t => {
  const { app, base, dir } = await seededApp(1);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const script = await rawGet(`${base}/app.js`, { 'accept-encoding': 'gzip, br' });
  const etag = script.headers.etag;
  assert.ok(etag, 'static responses must carry an ETag');
  assert.ok(['br', 'gzip'].includes(script.headers['content-encoding']), 'the bundle is compressed');
  assert.ok(script.bytes < 22_000, `compressed app.js should be under 22 KB on the wire, got ${script.bytes} (decoded ${script.decodedBytes})`);
  assert.equal(script.headers['cache-control'], 'max-age=0, must-revalidate');
  const revalidated = await rawGet(`${base}/app.js`, { 'if-none-match': etag, 'accept-encoding': 'gzip, br' });
  assert.equal(revalidated.status, 304, 'an unchanged asset must not be re-downloaded');
  assert.equal(revalidated.bytes, 0);
  const styles = await rawGet(`${base}/styles.css`, { 'accept-encoding': 'gzip, br' });
  // Budgets, not vibes. The v5 redesign added a landing screen, a conversational
  // intake, hand-written SVG graphics and a fourth breakpoint, so the old 6 KB
  // stylesheet ceiling no longer described this app. The per-file ceilings are
  // now paired with a COMBINED one: growth in either file has to be paid for out
  // of the other, which is the discipline that actually matters.
  assert.ok(styles.bytes < 8_000, `compressed styles.css should be under 8 KB, got ${styles.bytes}`);
  assert.ok(styles.bytes + script.bytes < 32_000, `the whole client should stay under 32 KB compressed, got ${styles.bytes + script.bytes}`);
  const identity = await rawGet(`${base}/app.js`);
  assert.equal(identity.headers['content-encoding'], undefined);
  assert.equal(identity.headers.etag, etag, 'the ETag is stable across encodings');
});

test('an assistant turn returns what the view needs without a second request', async t => {
  const { app, base, dir, provider, first } = await seededApp(1);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  provider.push({ reply: 'Progress looks fine.', impactSummary: 'Nothing to change.', affectedComponents: [], questions: [], actions: [] });
  const response = await fetch(`${base}/api/events/${first.id}/assistant`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'How are we tracking?' })
  });
  const json = await response.json();
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(json.conversation) && json.conversation.length >= 2, 'the turn returns the updated conversation');
  assert.equal(json.event.conversation, undefined, 'the event payload no longer carries history twice');
  assert.ok(json.event.tasks.length > 0 && json.event.aiProposal, 'the detail payload still holds the plan');
  const history = await (await fetch(`${base}/api/events/${first.id}/assistant`)).json();
  assert.equal(history.conversation.length, json.conversation.length, 'history endpoint agrees with the inline copy');
});

test('event detail no longer ships conversation on every load', async t => {
  const { app, base, dir, first } = await seededApp(1);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const detail = await rawGet(`${base}/api/events/${first.id}`, { 'accept-encoding': 'gzip' });
  assert.equal(detail.status, 200);
  assert.ok(!('conversation' in detail.json), 'conversation is fetched only by the assistant view');
  assert.ok(detail.json.aiProposal, 'the saved proposal is still available for review');
});

test('AI work is queued with a bound, never an unbounded backlog', async t => {
  const { app, dir } = await seededApp(1);
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(app.aiSlots.limit, 1, 'one generation runs at a time');
  assert.ok(app.aiSlots.maxQueue > 0 && app.aiSlots.maxQueue <= 64, `queue must be bounded, got ${app.aiSlots.maxQueue}`);
});
