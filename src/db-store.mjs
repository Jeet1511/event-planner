/**
 * Durable persistence for Supabase Postgres, spoken over PostgREST.
 *
 * Why PostgREST and not a driver: this project ships with zero dependencies and
 * no build step, and `node:fetch` is enough to talk to Supabase's REST endpoint.
 * A real Postgres driver would mean a third-party package.
 *
 * The store keeps the same small interface the application already uses
 * (`load`, `withEvents`, `sweep`, `state`, `drained`), so no route or view had
 * to change to become durable.
 *
 * Write strategy: each event is one row holding a JSONB document. After a
 * mutation the whole aggregate is digested per event and only rows whose digest
 * changed are upserted; rows that disappeared are deleted. That keeps a checkbox
 * click to one small UPSERT instead of rewriting every event, and it is exact —
 * the digest is over the stored document, not over a subset of fields.
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function normalizeRestUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('SUPABASE_REST_URL is not a valid URL.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('SUPABASE_REST_URL must be http or https.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('SUPABASE_REST_URL must use https unless it is a local test server.');
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * @param {object} options
 * @param {string} options.restUrl  e.g. https://<project>.supabase.co/rest/v1
 * @param {string} options.restKey  server-side only. Use the service-role key,
 *        because Row Level Security on the table denies `anon` — the application
 *        is the only thing allowed to read the workspace, and it gates access
 *        with its own session. Never expose this key to the browser.
 * @param {string} [options.table]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createDbStore({ restUrl, restKey, table = 'events', fetchImpl = fetch, now = () => new Date() } = {}) {
  if (!restUrl || !restKey) throw new Error('createDbStore needs both restUrl and restKey.');
  const base = normalizeRestUrl(restUrl);
  const headers = { 'content-type': 'application/json', apikey: restKey, authorization: `Bearer ${restKey}` };
  const state = { proposals: new Map(), actions: new Map() };
  let chain = Promise.resolve();
  let cached = null;
  let digests = new Map();

  async function request(path, init = {}) {
    const response = await fetchImpl(`${base}/${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Database request failed (HTTP ${response.status}) on ${init.method || 'GET'} ${path}: ${detail.slice(0, 240)}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function load() {
    if (cached) return cached;
    const rows = await request(`${table}?select=data&order=created_at.desc`);
    cached = (Array.isArray(rows) ? rows : []).map(row => row.data);
    digests = new Map(cached.map(event => [event.id, digest(event)]));
    return cached;
  }

  /** Write only what changed. Returns how many rows were touched. */
  async function persist(events) {
    const next = new Map(events.map(event => [event.id, digest(event)]));
    const changed = events.filter(event => digests.get(event.id) !== next.get(event.id));
    const removed = [...digests.keys()].filter(id => !next.has(id));
    if (changed.length) {
      await request(`${table}?on_conflict=id`, {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(changed.map(event => ({ id: event.id, data: event, updated_at: now().toISOString() })))
      });
    }
    if (removed.length) {
      await request(`${table}?id=in.(${removed.map(id => `"${id}"`).join(',')})`, {
        method: 'DELETE', headers: { prefer: 'return=minimal' }
      });
    }
    cached = events;
    digests = next;
    return { upserted: changed.length, deleted: removed.length };
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function withEvents(mutator) {
    return enqueue(async () => {
      const events = await load();
      const result = await mutator(events);
      await persist(events);
      return result;
    });
  }

  function sweep() {
    const instant = now().getTime();
    for (const [id, entry] of state.proposals) if (entry.expiresAt <= instant) state.proposals.delete(id);
    for (const [id, entry] of state.actions) if (entry.expiresAt <= instant) state.actions.delete(id);
    for (const map of [state.proposals, state.actions]) {
      while (map.size > 200) map.delete(map.keys().next().value);
    }
  }

  /**
   * Liveness for the platform's health check. A deploy that comes up pointing at
   * the wrong project must fail loudly here rather than silently store nothing.
   */
  async function ping() {
    await request(`${table}?select=id&limit=1`);
    return { ok: true, table };
  }

  return {
    kind: 'supabase',
    // Uploads still land on the local disk; on an ephemeral filesystem that is a
    // known limit, recorded in DEPLOYMENT_RENDER.md rather than papered over.
    uploadDir: 'private-uploads',
    load, withEvents, sweep, state, ping,
    drained: () => chain,
    newId: () => randomUUID()
  };
}
