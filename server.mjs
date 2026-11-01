import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, gzipSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPlan, validateEvent, validateExpense, calculateBudget, indiaDateToday } from './src/core.mjs';
import { aiHealth, activeProvider, assistantTurn, cleanError, consultTurn, generatePlan, screenActions, understandBrief, validateAIProposal } from './src/ai.mjs';
import { applyActions, analyzeImpact, budgetView, eventFingerprint, isoDate, plannedGuests, resolveSchedule, RUPEE, sharesToPaise } from './src/planning.mjs';
import { assertSafeDeployment, readCookies, secretMatches } from './src/deployment.mjs';

const COMPRESS_MIN_BYTES = 860;

/**
 * Content negotiation for compression. Dynamic JSON uses gzip/deflate at a cheap
 * level because the CPU has to be paid for on every request; static files are
 * compressed once and cached, so they can afford Brotli's better ratio.
 */
function chooseEncoding(accept = '') {
  if (/\bgzip\b/.test(accept)) return 'gzip';
  if (/\bdeflate\b/.test(accept)) return 'deflate';
  return null;
}
function compressDynamic(buffer, encoding) {
  if (!encoding || buffer.length < COMPRESS_MIN_BYTES) return null;
  const fast = buffer.length > 150_000;
  return encoding === 'gzip'
    ? gzipSync(buffer, { level: fast ? 1 : 6 })
    : deflateSync(buffer, { level: fast ? 1 : 6 });
}
function compressStatic(buffer, accept) {
  if (buffer.length < COMPRESS_MIN_BYTES) return { payload: buffer, encoding: null };
  if (/\bbrotli\b/.test(accept)) {
    return { payload: brotliCompressSync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }), encoding: 'br' };
  }
  const encoding = chooseEncoding(accept);
  return encoding ? { payload: compressDynamic(buffer, encoding), encoding } : { payload: buffer, encoding: null };
}

/**
 * Static file cache: bytes are read from disk once per version, hashed into an
 * ETag, and each encoding variant is compressed once. A changed file (size or
 * mtime) invalidates the entry, so no stale asset can be served.
 */
function createStaticCache() {
  const entries = new Map();
  return {
    get(filePath) {
      let stats;
      try { stats = statSync(filePath); } catch { return null; }
      const signature = `${stats.size}:${stats.mtimeMs}`;
      const existing = entries.get(filePath);
      if (existing && existing.signature === signature) return existing;
      const entry = {
        signature,
        raw: readFileSync(filePath),
        etag: `"${createHash('sha1').update(`${filePath}|${signature}`).digest('base64url').slice(0, 24)}"`,
        variants: new Map()
      };
      entries.set(filePath, entry);
      if (entries.size > 40) entries.delete(entries.keys().next().value);
      return entry;
    }
  };
}

function staticVariant(entry, accept) {
  if (entry.raw.length < COMPRESS_MIN_BYTES) return { payload: entry.raw, encoding: null };
  const wanted = /\bbrotli\b/.test(accept) ? 'br' : chooseEncoding(accept);
  if (!wanted) return { payload: entry.raw, encoding: null };
  if (!entry.variants.has(wanted)) {
    entry.variants.set(wanted, wanted === 'br'
      ? brotliCompressSync(entry.raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : compressDynamic(entry.raw, wanted));
  }
  return { payload: entry.variants.get(wanted), encoding: wanted };
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
};
const HISTORY_LIMIT = 60;
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}

/**
 * Workspace session. The cookie holds `nonce.hmac(nonce)` keyed by the workspace
 * secret, so the secret itself never reaches the browser.
 *
 * Stateless tokens cannot normally be revoked, which would make "sign out"
 * decorative — so revoked nonces are remembered for the remaining lifetime of a
 * session. The map is bounded and swept, because an unbounded revocation list is
 * just a memory leak with good intentions.
 */
const SESSION_COOKIE = 'eventpilot_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REVOCATION_CAP = 5000;
const sessionSign = (secret, nonce) => createHmac('sha256', secret).update(nonce).digest('hex');
function issueSessionToken(secret) {
  const nonce = randomBytes(16).toString('hex');
  return `${nonce}.${sessionSign(secret, nonce)}`;
}
function sessionTokenParts(token) {
  const [nonce, signature] = String(token || '').split('.');
  if (!nonce || !signature || !/^[0-9a-f]{32}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  return { nonce, signature };
}
function sessionValid(secret, token, revoked) {
  const parts = sessionTokenParts(token);
  if (!parts || revoked.has(parts.nonce)) return false;
  const expected = Buffer.from(sessionSign(secret, parts.nonce), 'hex');
  const given = Buffer.from(parts.signature, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
function revokeSession(revoked, token, instant) {
  const parts = sessionTokenParts(token);
  if (!parts) return;
  revoked.set(parts.nonce, instant + SESSION_TTL_MS);
  for (const [nonce, expiresAt] of revoked) if (expiresAt <= instant) revoked.delete(nonce);
  while (revoked.size > SESSION_REVOCATION_CAP) revoked.delete(revoked.keys().next().value);
}
function sessionCookie(token, { secure, maxAge = SESSION_TTL_MS / 1000 } = {}) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

/**
 * Serialises writes without ever holding the lock across a model call: reads
 * happen freely, mutations are one synchronous pass plus an atomic rename.
 */
function createStore({ dataDir, now = () => new Date() }) {
  const db = path.join(dataDir, 'events.json');
  const uploadDir = path.join(dataDir, 'private-uploads');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(uploadDir, { recursive: true });
  let chain = Promise.resolve();
  let parsed = null;
  const state = { proposals: new Map(), actions: new Map() };

  /**
   * Parsed store is cached for the process lifetime and dropped the moment a
   * write fails, so memory can never drift from the file it claims to hold.
   */
  async function load() {
    if (parsed) return parsed;
    try { parsed = JSON.parse(await readFile(db, 'utf8')); } catch { parsed = []; }
    return parsed;
  }
  async function persist(data) {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    const temporary = `${db}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { flag: 'wx' });
      await rename(temporary, db);
      parsed = data;
    } catch (error) {
      parsed = null;
      throw error;
    }
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
    // Bound memory: oldest entries go first when the maps keep growing.
    for (const map of [state.proposals, state.actions]) {
      while (map.size > 200) map.delete(map.keys().next().value);
    }
  }
  return { db, uploadDir, load, withEvents, state, sweep, drained: () => chain };
}

function planHealth(event) {
  const view = budgetView(event);
  const today = indiaDateToday();
  return {
    allocatedINR: RUPEE(view.allocatedPaise), spentINR: RUPEE(view.spentPaise),
    unallocatedINR: RUPEE(view.unallocatedPaise), remainingINR: RUPEE(view.remainingPaise),
    utilisationPercent: view.utilisationPercent,
    overAllocated: view.overAllocated, overSpent: view.overSpent,
    overdueTasks: (event.tasks || []).filter(task => task.status !== 'completed' && task.dueDate && task.dueDate < today).length,
    daysToEvent: event.date ? Math.round((Date.parse(`${event.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) : null,
    bookingRisk: !!event.date && Math.round((Date.parse(`${event.date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000) <= 30
      && (event.vendors || []).every(vendor => vendor.status !== 'booked')
  };
}

/**
 * The list endpoint sends only what a card renders. Previously every event's
 * full task descriptions, strategies, risks and proposal payload went down the
 * wire for a screen that shows a name, a date and a progress bar.
 */
function listEvent(event) {
  const tasks = event.tasks || [];
  const health = planHealth(event);
  return {
    id: event.id, name: event.name, type: event.type, city: event.city, date: event.date,
    budget: event.budget, currency: event.currency || 'INR',
    guestsCount: plannedGuests(event), guestsAdded: (event.guests || []).length,
    planSource: event.planSource || 'template', aiProvider: event.aiProvider || null,
    taskCount: tasks.length, tasksCompleted: tasks.filter(task => task.status === 'completed').length,
    // Slim task view: enough to tick a task off straight from a card, without
    // shipping every description for an event the user is not looking at.
    taskBrief: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, dueDate: task.dueDate, priority: task.priority })),
    // Names and amounts only: the landing screen adds these up across events to
    // show where the money is planned, which needs no description or rationale.
    categoryBrief: (event.categories || []).map(category => ({ name: category.name, allocation: Number(category.allocation) || 0 })),
    summary: calculateBudget(event),
    planHealth: {
      overSpent: health.overSpent, overAllocated: health.overAllocated, overdueTasks: health.overdueTasks,
      remainingINR: health.remainingINR, daysToEvent: health.daysToEvent, bookingRisk: health.bookingRisk
    }
  };
}

function safeEvent(event, { list = false } = {}) {
  if (list) return listEvent(event);
  const { conversation, ...rest } = event;
  return { ...rest, summary: calculateBudget(event), planHealth: planHealth(event) };
}

/** Turns a validated plan proposal into the shape createPlan returns. */
function applyProposal(plan, proposal) {
  const totalPaise = Math.round(Number(plan.event.budget) * 100);
  const categories = proposal.budgetCategories.length ? (() => {
    const paise = sharesToPaise(totalPaise, proposal.budgetCategories.map(category => category.sharePercent));
    return proposal.budgetCategories.map((category, index) => ({
      name: category.name, allocation: RUPEE(paise[index]), sharePercent: category.sharePercent,
      rationale: category.rationale, source: 'ai-suggestion'
    }));
  })() : plan.categories;
  const { tasks: scheduled, warnings } = resolveSchedule(proposal.tasks, plan.event.date, indiaDateToday());
  const tasks = scheduled.map(task => ({ ...task, id: randomUUID(), status: 'pending', source: 'ai-suggestion' }));
  const ideas = proposal.ideas.map(idea => `${idea.title}: ${idea.description}`);
  return {
    ...plan, categories, tasks, ideas, scheduleWarnings: warnings,
    strategy: proposal.strategy,
    vendorRequirements: proposal.vendorRequirements.map(item => ({ ...item, id: randomUUID(), status: 'to-research', source: 'ai-suggestion' })),
    risks: proposal.risks,
    assumptions: proposal.assumptions, missingInformation: proposal.missingInformation,
    aiSuggestions: ideas.join('\n\n'), aiProposal: proposal,
    provenance: { source: 'structured-ai', generatedAt: new Date().toISOString(), note: 'AI suggestion: no vendor identity, price, availability or permission was verified.' }
  };
}

const str = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const LIST_FIELDS = ['style', 'culture', 'dietary', 'accessibility', 'priorities', 'constraints'];
function sanitizeProfile(input = {}) {
  const profile = {};
  for (const field of LIST_FIELDS) {
    const value = Array.isArray(input[field]) ? input[field] : [];
    profile[field] = value.slice(0, 12).map(item => String(item).trim().slice(0, 160)).filter(Boolean);
  }
  return profile;
}

/**
 * The pre-event draft is client-held and untrusted, so it is re-validated here
 * on every turn: a tampered draft cannot smuggle a bad date, a negative budget
 * or a 100,000-guest event into plan generation.
 */
function sanitizeDraft(input = {}) {
  const list = value => Array.isArray(value) ? value.slice(0, 6).map(item => String(item).trim().slice(0, 160)).filter(Boolean) : [];
  const guests = Number(input.guests);
  const budget = Number(input.budget);
  const date = isoDate(String(input.date ?? ''));
  return {
    name: String(input.name ?? '').trim().slice(0, 100),
    type: ['wedding', 'birthday', 'community'].includes(input.type) ? input.type : null,
    city: String(input.city ?? '').trim().slice(0, 80),
    date: date && date >= indiaDateToday() ? date : null,
    guests: Number.isInteger(guests) && guests > 0 && guests <= 100_000 ? guests : null,
    budget: Number.isFinite(budget) && budget > 0 && budget <= 1_000_000_000 ? Math.round(budget * 100) / 100 : null,
    style: list(input.style),
    priorities: list(input.priorities)
  };
}

/** Everything the planner was told, as one brief for deterministic planning. */
function historyText(history, message) {
  return [...(history || []).filter(item => item.role === 'user').map(item => item.content), message]
    .filter(Boolean).join('\n').slice(0, 4000);
}

function summarizeAction(action) {
  const inr = value => `₹${Number(value).toLocaleString('en-IN')}`;
  switch (action.op) {
    case 'update_event': return { op: action.op, label: `Set ${action.field} to ${action.value}` };
    case 'set_budget_allocation': return { op: action.op, label: `${action.categoryName}: allocate ${inr(action.allocationINR)}` };
    case 'add_budget_category': return { op: action.op, label: `Add category ${action.name} (${inr(action.allocationINR || 0)})` };
    case 'add_tasks': return { op: action.op, label: `Add ${action.tasks.length} task(s): ${action.tasks.map(task => task.title).join('; ').slice(0, 320)}` };
    case 'update_task': return { op: action.op, label: `Update "${action.taskTitle}" → ${Object.entries(action.patch).map(([key, value]) => `${key}: ${value}`).join(', ')}` };
    case 'remove_task': return { op: action.op, label: `Remove task "${action.taskTitle}"` };
    case 'add_vendor_requirement': return { op: action.op, label: `Vendor requirement: ${action.category}${action.why ? ` — ${action.why}` : ''}` };
    case 'update_vendor_status': return { op: action.op, label: `Mark ${action.vendorName} as ${action.status}` };
    case 'set_profile': return { op: action.op, label: `Update ${action.field} in the event profile` };
    case 'add_ideas': return { op: action.op, label: `Add ${action.ideas.length} idea(s): ${action.ideas.map(idea => idea.title).join('; ').slice(0, 320)}` };
    default: return { op: String(action.op), label: String(action.op) };
  }
}

/** Deterministic preview of the money effect of an unapproved proposal. */
function deterministicPreview(event, actions) {
  const before = budgetView(event);
  const projected = structuredClone(event);
  for (const action of actions) {
    if (action.op === 'update_event' && action.field === 'budget') projected.budget = action.value;
    if (action.op === 'set_budget_allocation') {
      const category = (projected.categories || []).find(item => item.id === action.categoryId);
      if (category) category.allocation = action.allocationINR;
    }
    if (action.op === 'add_budget_category') projected.categories = [...(projected.categories || []), { id: 'preview', name: action.name, allocation: action.allocationINR }];
  }
  const after = budgetView(projected);
  return {
    before: { allocatedINR: RUPEE(before.allocatedPaise), spentINR: RUPEE(before.spentPaise), remainingINR: RUPEE(before.remainingPaise) },
    after: { allocatedINR: RUPEE(after.allocatedPaise), spentINR: RUPEE(after.spentPaise), remainingINR: RUPEE(after.remainingPaise) },
    overAllocated: after.overAllocated, overSpent: after.overSpent,
    note: 'Totals are computed by the application from stored records, not by the model.'
  };
}

function fallbackStrategy(event) {
  return {
    overview: `${event.type} for about ${Number(event.guests) || 0} guests in ${event.city}${event.date ? ` on ${event.date}` : ''}, with an INR ${Number(event.budget).toLocaleString('en-IN')} budget.`,
    concept: 'Built from deterministic templates because no structured AI proposal was available.',
    theme: 'Not set',
    priorities: ['Confirm date and venue', 'Fix the budget split', 'Book long-lead vendors'],
    challenges: ['No AI analysis was available for this plan.'],
    recommendations: ['Configure an AI provider, then ask the planning assistant to revise any section.']
  };
}

function fallbackRisks(event) {
  const risks = [{ risk: 'Vendor commitments are unverified', mitigation: 'Collect written quotations and confirm booking terms before paying deposits.' }];
  if (!event.date) risks.push({ risk: 'No event date set', mitigation: 'Fix the date so deadlines and lead times can be calculated.' });
  else if (event.date < indiaDateToday()) risks.push({ risk: 'The event date is in the past', mitigation: 'Update the date; open tasks currently show clamped deadlines.' });
  const guests = Number(event.guests) || 0;
  if (guests > 0 && Number(event.budget) / guests < 500) risks.push({ risk: 'Budget per guest is low for this guest count', mitigation: 'Trim guests, or simplify catering and decoration before making firm commitments.' });
  return risks;
}

function fallbackVendorRequirements(event) {
  const base = [
    { category: 'Venue', why: 'Decoration, catering and guest logistics all depend on the space being confirmed.', whenBeforeEventDays: 90, priority: 'high' },
    { category: 'Catering', why: 'Quantities scale directly with the guest count you set.', whenBeforeEventDays: 45, priority: 'high' },
    { category: 'Photography', why: 'Demand for fixed dates is high; early booking protects your slot.', whenBeforeEventDays: 60, priority: 'medium' }
  ];
  const extra = {
    wedding: [{ category: 'Clothing & makeup', why: 'Styling trials and fittings need lead time.', whenBeforeEventDays: 45, priority: 'medium' }],
    birthday: [{ category: 'Cake & entertainment', why: 'Theme activities and cake orders are easier to arrange early.', whenBeforeEventDays: 14, priority: 'medium' }],
    community: [{ category: 'Permissions & safety', why: 'Local permissions, crowd flow and accessibility cannot be arranged late.', whenBeforeEventDays: 90, priority: 'high' }]
  };
  return [...base, ...(extra[event.type] || [])].map(item => ({
    ...item, selectionCriteria: ['Written quotation', 'Deposit and cancellation terms', 'References you verify yourself'],
    status: 'to-research', source: 'template'
  }));
}

export function createApp({ dataDir, ai = null, now = () => new Date(), store: injectedStore = null, accessKey = process.env.EVENTPILOT_ACCESS_KEY || '' } = {}) {
  const resolvedDataDir = dataDir ? path.resolve(dataDir) : path.join(ROOT, 'data');
  const store = injectedStore || createStore({ dataDir: resolvedDataDir, now });
  const providerOptions = ai || {};
  // A workspace secret turns every API route into a keyed endpoint. Empty means
  // "local demo": the deployment guard then refuses anything but loopback binding.
  const workspaceSecret = String(accessKey || '').trim();
  // Uploads are the one thing persistence does not cover yet: quotation files
  // still go to the local disk, which is durable on a mounted volume and lost on
  // an ephemeral filesystem. Recorded as a limit in DEPLOYMENT_RENDER.md.
  const uploadDir = path.join(resolvedDataDir, 'private-uploads');
  mkdirSync(uploadDir, { recursive: true });
  const aiSlots = { active: 0, limit: Number(process.env.EVENTPILOT_AI_CONCURRENCY || 1), queue: [], maxQueue: 32 };
  const staticCache = createStaticCache();
  const buckets = new Map();
  const revokedSessions = new Map();

  const send = (res, status, bodyValue) => {
    const buffer = Buffer.from(JSON.stringify(bodyValue));
    const encoding = chooseEncoding(res.req?.headers['accept-encoding'] || '');
    const payload = compressDynamic(buffer, encoding);
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'vary': 'Accept-Encoding', ...SECURITY_HEADERS };
    if (payload) headers['content-encoding'] = encoding;
    res.writeHead(status, headers);
    res.end(payload || buffer);
  };

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new HttpError(413, 'Request body exceeds 8 MB.');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Request body must be valid JSON.'); }
  }

  function takeQuota(key, limit = Number(process.env.EVENTPILOT_AI_RATE_LIMIT_PER_MINUTE || 30), windowMs = 60_000) {
    const instant = now().getTime();
    for (const [stored, bucket] of buckets) if (bucket.resetAt <= instant) buckets.delete(stored);
    const bucket = buckets.get(key) || { count: 0, resetAt: instant + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      throw new HttpError(429, `Too many AI requests from this client. Wait ${Math.max(1, Math.ceil((bucket.resetAt - instant) / 1000))}s and try again.`);
    }
  }

  /** One live generation at a time: protects free-tier quota and keeps the JSON
   * store from being written by parallel model responses. */
  function withAiSlot(task) {
    return new Promise((resolve, reject) => {
      if (aiSlots.queue.length >= aiSlots.maxQueue) {
        reject(new HttpError(503, 'The AI queue is full. Try again in a moment — your saved data is unchanged.'));
        return;
      }
      const attempt = () => {
        if (aiSlots.active >= aiSlots.limit) { aiSlots.queue.push(attempt); return; }
        aiSlots.active += 1;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          aiSlots.active -= 1;
          const next = aiSlots.queue.shift();
          if (next) next();
        });
      };
      attempt();
    });
  }

  async function aiCall(label, request) {
    const provider = activeProvider(providerOptions);
    if (!provider) {
      return { unavailable: true, code: 'no_credentials', detail: 'No AI provider is configured on this server, so the deterministic planner was used.' };
    }
    try {
      return await withAiSlot(() => request(provider));
    } catch (error) {
      const cleaned = cleanError(error);
      // The provider's own reason is forwarded (redacted) so the UI can say what
      // actually happened and when to retry, instead of a generic failure line.
      return {
        unavailable: true, code: cleaned.status, detail: `${label} is unavailable: ${cleaned.message}`,
        cause: cleaned.detail, retryAfterSeconds: cleaned.retryAfterSeconds
      };
    }
  }

  function providerModeLabel(providerId) {
    return providerId === 'ollama' ? 'local-ollama' : `${providerId}-structured`;
  }

  /**
   * One shape for every AI failure, so the client can always tell the user what
   * happened and whether retrying will help. A quota refusal is a 429 with the
   * provider's own wait time; everything else that stops generation is a 503.
   * Saved data is never touched on this path.
   */
  function sendAiFailure(res, result, extra = {}) {
    const status = result.code === 'rate_limited' ? 429 : 503;
    if (result.retryAfterSeconds) res.setHeader('retry-after', String(result.retryAfterSeconds));
    return send(res, status, {
      error: result.detail, code: result.code, cause: result.cause || null,
      retryAfterSeconds: result.retryAfterSeconds ?? null, keepExistingData: true, ...extra
    });
  }

  async function eventById(id) {
    const event = (await store.load()).find(item => item.id === id);
    if (!event) throw new HttpError(404, 'Event not found.');
    // Cloned: routes keep this as a pre-mutation snapshot for fingerprints and
    // money previews, and the store now hands out a shared cached object.
    return structuredClone(event);
  }

  async function uploadQuotationFile(input, vendor) {
    if (!input.fileData) return null;
    const matched = String(input.fileData).match(/^data:(application\/pdf|image\/jpeg|image\/png);base64,([A-Za-z0-9+/=]+)$/);
    if (!matched) throw new HttpError(400, 'Only PDF, JPEG or PNG quotation files are accepted.');
    const buffer = Buffer.from(matched[2], 'base64');
    if (!buffer.length || buffer.length > 5 * 1024 * 1024) throw new HttpError(400, 'Quotation file must be under 5 MB.');
    const valid = (matched[1] === 'application/pdf' && buffer.subarray(0, 5).toString() === '%PDF-')
      || (matched[1] === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
      || (matched[1] === 'image/png' && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    if (!valid) throw new HttpError(400, 'File content does not match its declared type.');
    const extension = matched[1] === 'application/pdf' ? '.pdf' : matched[1] === 'image/jpeg' ? '.jpg' : '.png';
    const filename = `${randomUUID()}${extension}`;
    await writeFile(path.join(uploadDir, filename), buffer, { flag: 'wx' });
    return { filename, mimeType: matched[1], size: buffer.length, vendorId: vendor.id };
  }

  const routes = {
    async health(req, res) {
      const ai = await aiHealth(providerOptions);
      return { ok: true, mode: 'local-demo', ai, fallbackAvailable: true, eventCount: (await store.load()).length };
    },

    async understand(req, res) {
      const input = await readBody(req);
      const brief = str(input.brief, 4000);
      if (brief.length < 12) throw new HttpError(400, 'Describe your event in a sentence or two first.');
      takeQuota(`${req.socket.remoteAddress}:understand`);
      const result = await aiCall('Event understanding', provider => understandBrief(brief, { provider }));
      if (result.unavailable) return sendAiFailure(res, result, { fallback: 'manual-form', brief });
      send(res, 200, { extraction: result.extraction, provider: result.provider, model: result.model, generatedAt: result.createdAt, brief });
    },

    async consult(req, res) {
      const input = await readBody(req);
      const message = str(input.message, 3000);
      if (message.length < 4) throw new HttpError(400, 'Say a little more about the event first.');
      const draft = sanitizeDraft(input.draft);
      const history = (Array.isArray(input.history) ? input.history : []).slice(-8)
        .filter(item => item && typeof item.text === 'string')
        .map(item => ({ role: item.role === 'user' ? 'user' : 'assistant', content: String(item.text).slice(0, 400) }));
      takeQuota(`${req.socket.remoteAddress}:consult`);
      const result = await aiCall('Planning conversation', provider => consultTurn({ message, history, draft, provider }));
      if (result.unavailable) return sendAiFailure(res, result, { draft });
      send(res, 200, {
        reply: result.reply, questions: result.questions, fields: result.fields,
        ready: result.ready, missing: result.missing, brief: historyText(history, message),
        provider: result.provider, model: result.model
      });
    },

    async plan(req, res) {
      const input = await readBody(req);
      const plan = createPlan(input);
      plan.brief = str(input.brief, 4000) || null;
      const profile = sanitizeProfile(input.profile || {});
      takeQuota(`${req.socket.remoteAddress}:plan`);
      const result = await aiCall('Plan generation', provider => generatePlan({ ...plan.event, brief: plan.brief, profile }, { provider }));
      if (result.unavailable) {
        plan.mode = 'rules-fallback';
        plan.aiGenerated = false;
        plan.aiStatus = result.code;
        plan.aiDetail = result.detail;
        plan.aiCause = result.cause || null;
        plan.aiRetryAfterSeconds = result.retryAfterSeconds ?? null;
        plan.strategy = fallbackStrategy(plan.event);
        plan.risks = fallbackRisks(plan.event);
        plan.vendorRequirements = fallbackVendorRequirements(plan.event);
        plan.assumptions = [];
        plan.missingInformation = plan.event.date ? [] : ['Event date is not set, so deadlines cannot be calculated.'];
        return send(res, 200, plan);
      }
      const proposalId = randomUUID();
      store.sweep();
      store.state.proposals.set(proposalId, {
        id: proposalId, proposal: result.proposal, model: result.model, provider: result.provider,
        fingerprint: eventFingerprint(plan.event), status: 'pending', createdAt: now().toISOString(),
        expiresAt: now().getTime() + PROPOSAL_TTL_MS
      });
      const applied = applyProposal(plan, result.proposal);
      Object.assign(applied, {
        proposalId, aiProvider: result.provider, aiModel: result.model, aiGenerated: true,
        mode: providerModeLabel(result.provider), repaired: Boolean(result.repaired), usage: result.usage
      });
      send(res, 200, applied);
    },

    async createEvent(req, res) {
      const input = await readBody(req);
      const plan = createPlan(input);
      const brief = str(input.brief, 4000) || null;
      let approved = null;
      let origin = { model: null, provider: null };
      if (input.proposalId) {
        const pending = store.state.proposals.get(String(input.proposalId));
        if (!pending || pending.expiresAt <= now().getTime()) {
          store.state.proposals.delete(String(input.proposalId));
          throw new HttpError(410, 'This AI proposal expired. Generate a fresh plan before saving.');
        }
        if (pending.status !== 'pending') throw new HttpError(410, 'That AI proposal was already used. Generate a fresh plan before saving.');
        if (pending.fingerprint !== eventFingerprint(plan.event)) throw new HttpError(409, 'Event details changed after plan generation. Generate a fresh proposal before saving.');
        approved = validateAIProposal(pending.proposal, plan.event);
        origin = { model: pending.model, provider: pending.provider };
        store.state.proposals.set(pending.id, { ...pending, status: 'consumed' });
      }
      const withProposal = approved ? applyProposal(plan, approved) : plan;
      const event = {
        id: randomUUID(), ...withProposal.event, guestsCount: withProposal.event.guests, brief,
        profile: sanitizeProfile(input.profile || plan.event.profile || {}),
        categories: withProposal.categories.map(category => ({ id: randomUUID(), ...category })),
        tasks: withProposal.tasks, ideas: withProposal.ideas, scheduleWarnings: withProposal.scheduleWarnings || [],
        strategy: withProposal.strategy || fallbackStrategy(withProposal.event),
        vendorRequirements: withProposal.vendorRequirements || fallbackVendorRequirements(withProposal.event),
        risks: withProposal.risks || fallbackRisks(withProposal.event),
        assumptions: withProposal.assumptions || [], missingInformation: withProposal.missingInformation || [],
        aiSuggestions: approved ? (withProposal.aiSuggestions || '') : '',
        aiProposal: approved || null,
        planSource: approved ? 'ai-suggestion' : 'template',
        aiModel: approved ? origin.model : null,
        aiProvider: approved ? origin.provider : null,
        conversation: [], guests: [], vendors: [], expenses: [], quotations: [],
        createdAt: now().toISOString(), updatedAt: now().toISOString()
      };
      const created = await store.withEvents(events => { events.unshift(event); return event; });
      send(res, 201, safeEvent(created));
    },

    async listEvents(req, res) {
      send(res, 200, (await store.load()).map(event => safeEvent(event, { list: true })));
    },

    async getEvent(req, res, { id }) {
      send(res, 200, safeEvent(await eventById(id)));
    },

    patchEvent(req, res, { id, input }) {
      return store.withEvents(events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        const previousDate = event.date;
        const merged = validateEvent({ ...event, ...input, guests: event.guestsCount });
        event.name = merged.name; event.city = merged.city; event.date = merged.date;
        if (previousDate !== merged.date) {
          const open = (event.tasks || []).filter(task => task.status !== 'completed' && task.dueDate && task.source !== 'user');
          const rescheduled = resolveSchedule(open.map(task => ({
            ...task, relativeDeadlineDays: task.dueDate ? Math.max(0, Math.round((Date.parse(`${merged.date}T12:00:00Z`) - Date.parse(`${task.dueDate}T12:00:00Z`)) / 86_400_000)) : null
          })), merged.date, indiaDateToday());
          for (const scheduled of rescheduled.tasks) {
            const target = event.tasks.find(task => task.title === scheduled.title && task.source !== 'user');
            if (target) { target.dueDate = scheduled.dueDate; target.urgency = scheduled.urgency; }
          }
          event.scheduleWarnings = rescheduled.warnings;
        }
        event.updatedAt = now().toISOString();
        return { event };
      });
    },

    async assistant(req, res, { id, input }) {
      const message = str(input.message, 3000);
      const focus = ['budget', 'timeline', 'vendors', 'ideas', 'risk', 'overall'].includes(input.focus) ? input.focus : null;
      if (message.length < 4 && !focus) throw new HttpError(400, 'Ask the assistant something about this event.');
      const prompt = message.length >= 4 ? message : `Revise only the ${focus} part of this plan.`;
      // Snapshot read-only, then generate outside the write queue.
      const snapshot = await eventById(id);
      const fingerprintBefore = eventFingerprint(snapshot);
      takeQuota(`${req.socket.remoteAddress}:${id.slice(0, 8)}:assistant`);
      const history = snapshot.conversation || [];
      const result = await aiCall('Planning assistant', provider => assistantTurn({ event: snapshot, message: prompt, history, focus, provider }));
      if (result.unavailable) return sendAiFailure(res, result, { keepExistingData: true, event: safeEvent(snapshot) });

      const turn = result.turn;
      const { accepted, rejected } = screenActions(snapshot, turn.actions);
      const screening = analyzeImpact(snapshot, accepted, { now: now() });
      const actionId = accepted.length && !screening.blockers.length ? randomUUID() : null;
      if (actionId) {
        store.sweep();
        store.state.actions.set(actionId, {
          id: actionId, eventId: id, actions: accepted, reply: turn.reply, impact: turn.impactSummary,
          affected: turn.affectedComponents, rejected, screening, model: result.model, provider: result.provider,
          fingerprint: fingerprintBefore, status: 'pending', createdAt: now().toISOString(),
          expiresAt: now().getTime() + PROPOSAL_TTL_MS
        });
      }
      const updated = await store.withEvents(events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        event.conversation = [...(event.conversation || []),
          { id: randomUUID(), role: 'user', content: prompt, createdAt: now().toISOString() },
          { id: randomUUID(), role: 'assistant', content: turn.reply, actionId, impact: turn.impactSummary, rejected, screening, actionStatus: actionId ? 'pending' : null, createdAt: now().toISOString() }
        ].slice(-HISTORY_LIMIT);
        event.updatedAt = now().toISOString();
        return { event };
      });
      send(res, 200, {
        reply: turn.reply, impact: turn.impactSummary, affected: turn.affectedComponents,
        questions: turn.questions, provider: result.provider, model: result.model, repaired: Boolean(result.repaired),
        rejected, screening,
        proposal: actionId ? {
          id: actionId, actions: accepted.map(summarizeAction), rejected, screening,
          deterministicCheck: deterministicPreview(snapshot, accepted),
          expiresAt: new Date(now().getTime() + PROPOSAL_TTL_MS).toISOString()
        } : null,
        event: safeEvent(updated.event), conversation: updated.event.conversation
      });
    },

    async listActions(req, res, { id }) {
      store.sweep();
      const event = await eventById(id);
      const proposals = [...store.state.actions.values()]
        .filter(item => item.eventId === id)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 10)
        .map(item => ({
          id: item.id, status: item.status, createdAt: item.createdAt,
          expiresAt: new Date(item.expiresAt).toISOString(), reply: item.reply, impact: item.impact,
          affected: item.affected, actions: item.actions.map(summarizeAction), rejected: item.rejected || [],
          screening: item.screening || { affected: [], warnings: [], blockers: [] },
          deterministicCheck: deterministicPreview(event, item.actions)
        }));
      send(res, 200, { proposals, note: 'Unapproved AI proposals live in server memory only; a restart discards them without touching saved event data.' });
    },

    resolveAction(req, res, { id, actionId, decision }) {
      return store.withEvents(events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        const pending = store.state.actions.get(String(actionId));
        if (!pending || pending.eventId !== id) throw new HttpError(404, 'That AI proposal no longer exists. Ask the assistant again.');
        if (pending.expiresAt <= now().getTime()) { store.state.actions.delete(pending.id); throw new HttpError(410, 'That AI proposal expired. Ask the assistant again.'); }
        if (pending.status !== 'pending') throw new HttpError(409, `That AI proposal was already ${pending.status}.`);
        // Validated against the persisted record, never against anything the client sent.
        if (pending.fingerprint !== eventFingerprint(event)) {
          pending.status = 'stale';
          throw new HttpError(409, 'This event changed since the proposal was created. Ask the assistant again before applying.');
        }
        // Re-checked at approval time against the stored record, not the snapshot.
        const screening = analyzeImpact(event, pending.actions, { now: now() });
        if (screening.blockers.length) {
          pending.status = 'blocked';
          throw new HttpError(409, `Cannot apply this proposal: ${screening.blockers.join(' ')}`);
        }
        if (decision === 'reject') {
          pending.status = 'rejected';
          return { event, status: 'dismissed', results: [{ op: 'rejected', ok: true, detail: 'Proposal dismissed. Nothing in your plan was changed.' }], changed: [] };
        }
        const applied = applyActions(event, pending.actions, { now: now() });
        pending.status = 'applied';
        pending.results = applied.results;
        event.conversation = (event.conversation || []).map(entry => entry.actionId === pending.id ? { ...entry, actionStatus: 'applied' } : entry);
        return { event, status: 'applied', results: applied.results, changed: applied.changed, rejected: pending.rejected || [] };
      });
    },

    async postResource(req, res, { id, resource, input }) {
      let preparedFile = null;
      if (resource === 'quotations') {
        const event = await eventById(id);
        const vendor = (event.vendors || []).find(item => item.id === input.vendorId);
        if (!vendor) throw new HttpError(400, 'Choose an event vendor and enter a valid quotation amount.');
        preparedFile = await uploadQuotationFile(input, vendor);
      }
      return store.withEvents(async events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        if (resource === 'categories') {
          const name = str(input.name, 60); const allocation = Number(input.allocation);
          if (name.length < 2 || !Number.isFinite(allocation) || allocation < 0 || allocation > 1_000_000_000) throw new HttpError(400, 'Enter a category name (2–60 characters) and a non-negative INR allocation.');
          if (event.categories.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'A category with this name already exists.');
          event.categories.push({ id: randomUUID(), name, allocation: Math.round(allocation * 100) / 100, source: 'user-entered' });
        } else if (resource === 'tasks') {
          const title = str(input.title, 160);
          if (title.length < 2 || title.length > 160) throw new HttpError(400, 'Task title must contain 2–160 characters.');
          const dueDate = input.dueDate ? String(input.dueDate) : null;
          if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || new Date(`${dueDate}T12:00:00Z`).toISOString().slice(0, 10) !== dueDate)) throw new HttpError(400, 'Task due date must be a real YYYY-MM-DD date.');
          if (event.tasks.some(task => task.title.toLowerCase() === title.toLowerCase())) throw new HttpError(409, 'A task with this title already exists.');
          event.tasks.push({ id: randomUUID(), title, dueDate, priority: ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium', status: 'pending', source: 'user' });
        } else if (resource === 'guests') {
          const name = str(input.name, 100);
          if (name.length < 2) throw new HttpError(400, 'Guest name must contain 2–100 characters.');
          event.guests.push({ id: randomUUID(), name, contact: str(input.contact, 120), rsvp: 'pending' });
        } else if (resource === 'vendors') {
          const name = str(input.name, 100); const category = str(input.category, 80);
          if (name.length < 2 || category.length < 2) throw new HttpError(400, 'Vendor name and category are required.');
          event.vendors.push({ id: randomUUID(), name, category, phone: str(input.phone, 40), status: 'enquiring', source: 'user-entered' });
        } else if (resource === 'expenses') {
          const key = String(input.idempotencyKey || '');
          if (!/^[a-f0-9-]{36}$/i.test(key)) throw new HttpError(400, 'A valid idempotency key is required for expense creation.');
          const existing = event.expenses.find(item => item.idempotencyKey === key);
          if (existing) {
            if (existing.description !== str(input.description, 160) || existing.amount !== Math.round(Number(input.amount) * 100) / 100 || existing.categoryId !== String(input.categoryId)) throw new HttpError(409, 'Idempotency key was already used for a different expense.');
            return { event, replay: true };
          }
          event.expenses.push(validateExpense(input, event));
        } else if (resource === 'quotations') {
          const vendor = event.vendors.find(item => item.id === input.vendorId);
          const amount = Number(input.amount);
          if (!vendor || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
            if (preparedFile) await removeUpload(preparedFile.filename);
            throw new HttpError(400, 'Choose an event vendor and enter a valid quotation amount.');
          }
          event.quotations.push({
            id: randomUUID(), vendorId: vendor.id, amount: Math.round(amount * 100) / 100, currency: 'INR',
            note: str(input.note, 300), source: 'user-entered', file: preparedFile || null,
            status: 'unverified', createdAt: now().toISOString()
          });
        } else if (resource === 'risks') {
          const risk = str(input.risk, 240); const mitigation = str(input.mitigation, 300);
          if (risk.length < 4 || mitigation.length < 4) throw new HttpError(400, 'A risk needs both a description and a mitigation.');
          event.risks = [...(event.risks || []), { risk, mitigation, source: 'user-entered' }];
        } else {
          throw new HttpError(405, 'Add is not supported for this resource.');
        }
        event.updatedAt = now().toISOString();
        return { event };
      });
    },

    patchResource(req, res, { id, resource, input }) {
      return store.withEvents(events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        if (resource === 'categories') {
          const category = event.categories.find(item => item.id === input.id);
          if (!category) throw new HttpError(404, 'Budget category not found.');
          if (input.name !== undefined) {
            const name = str(input.name, 60);
            if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Category name must contain 2–60 characters.');
            if (event.categories.some(item => item.id !== category.id && item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'A category with this name already exists.');
            category.name = name;
          }
          if (input.allocation !== undefined) {
            const allocation = Number(input.allocation);
            if (!Number.isFinite(allocation) || allocation < 0 || allocation > 1_000_000_000) throw new HttpError(400, 'Allocation must be a non-negative INR amount.');
            const spent = event.expenses.filter(item => item.categoryId === category.id).reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0);
            if (Math.round(allocation * 100) < spent) throw new HttpError(409, `This category already has ${RUPEE(spent).toFixed(2)} INR recorded; move those expenses first.`);
            category.allocation = Math.round(allocation * 100) / 100;
          }
          category.source = 'user-entered';
        } else if (resource === 'tasks') {
          const task = event.tasks.find(item => item.id === input.id);
          if (!task) throw new HttpError(404, 'Task not found.');
          if (input.status && ['pending', 'in_progress', 'completed'].includes(input.status)) task.status = input.status;
          if (input.priority && ['low', 'medium', 'high'].includes(input.priority)) task.priority = input.priority;
          if (input.title !== undefined) {
            const title = str(input.title, 160);
            if (title.length < 2) throw new HttpError(400, 'Task title must contain 2–160 characters.');
            task.title = title;
          }
          if (input.dueDate !== undefined) {
            const due = input.dueDate === null || input.dueDate === '' ? null : String(input.dueDate);
            if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || new Date(`${due}T12:00:00Z`).toISOString().slice(0, 10) !== due)) throw new HttpError(400, 'Task due date must be a real YYYY-MM-DD date.');
            task.dueDate = due;
          }
        } else if (resource === 'guests') {
          const guest = event.guests.find(item => item.id === input.id);
          if (!guest) throw new HttpError(404, 'Guest not found.');
          if (['pending', 'accepted', 'declined'].includes(input.rsvp)) guest.rsvp = input.rsvp;
        } else if (resource === 'vendors') {
          const vendor = event.vendors.find(item => item.id === input.id);
          if (!vendor) throw new HttpError(404, 'Vendor not found.');
          if (['enquiring', 'quoted', 'booked', 'cancelled'].includes(input.status)) vendor.status = input.status;
        } else if (resource === 'vendor-requirements') {
          const requirement = (event.vendorRequirements || []).find(item => item.id === input.id);
          if (!requirement) throw new HttpError(404, 'Vendor requirement not found.');
          if (['to-research', 'enquiring', 'booked', 'not-needed'].includes(input.status)) requirement.status = input.status;
        } else if (resource === 'profile') {
          event.profile = sanitizeProfile({ ...(event.profile || {}), ...(input.values || {}) });
        } else {
          throw new HttpError(405, 'Editing is not supported for this resource.');
        }
        event.updatedAt = now().toISOString();
        return { event };
      });
    },

    deleteResource(req, res, { id, resource, input }) {
      return store.withEvents(events => {
        const event = events.find(item => item.id === id);
        if (!event) throw new HttpError(404, 'Event not found.');
        const key = { tasks: 'tasks', guests: 'guests', vendors: 'vendors', 'vendor-requirements': 'vendorRequirements' }[resource];
        if (resource === 'categories') {
          if (event.expenses.some(item => item.categoryId === input.id)) throw new HttpError(409, 'Move or remove expenses in this category before deleting it.');
          const before = event.categories.length;
          event.categories = event.categories.filter(item => item.id !== input.id);
          if (before === event.categories.length) throw new HttpError(404, 'Budget category not found.');
        } else if (key) {
          const before = (event[key] || []).length;
          event[key] = (event[key] || []).filter(item => item.id !== input.id);
          if (before === event[key].length) throw new HttpError(404, 'Record not found.');
        } else {
          throw new HttpError(405, 'Deletion is not supported for this resource.');
        }
        event.updatedAt = now().toISOString();
        return { event };
      });
    }
  };

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (['POST', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'Cross-origin write request blocked.');
      if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Write requests must use application/json.');
    }
    const secureTransport = req.headers['x-forwarded-proto'] === 'https';
    if (url.pathname.startsWith('/api/')) {
      // Health stays reachable for platform probes, but it stops describing the
      // workspace the moment the deployment is keyed.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const health = await routes.health(req, res);
        if (workspaceSecret) delete health.eventCount;
        return send(res, 200, health);
      }
      if (workspaceSecret) {
        if (req.method === 'POST' && url.pathname === '/api/session') {
          // Tighter than the AI budget: this is the only endpoint that gets to
          // say whether the workspace secret is right, so guessing must be slow.
          takeQuota(`${req.socket.remoteAddress}:session`, 5);
          const input = await readBody(req);
          if (!secretMatches(str(input.key, 200), workspaceSecret)) throw new HttpError(401, 'That workspace key is not correct.');
          res.setHeader('set-cookie', sessionCookie(issueSessionToken(workspaceSecret), { secure: secureTransport }));
          return send(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && url.pathname === '/api/session') {
          revokeSession(revokedSessions, readCookies(req.headers.cookie || '')[SESSION_COOKIE], now().getTime());
          res.setHeader('set-cookie', sessionCookie('', { secure: secureTransport, maxAge: 0 }));
          return send(res, 200, { ok: true });
        }
        const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
        const authorized = secretMatches(bearer, workspaceSecret)
          || sessionValid(workspaceSecret, readCookies(req.headers.cookie || '')[SESSION_COOKIE], revokedSessions);
        if (!authorized) throw new HttpError(401, 'This workspace is locked. Enter the workspace key to continue.');
      }
      if (req.method === 'GET' && url.pathname === '/api/events') return routes.listEvents(req, res);
      if (req.method === 'POST' && url.pathname === '/api/plan') return routes.plan(req, res);
      if (req.method === 'POST' && url.pathname === '/api/ai/understand') return routes.understand(req, res);
      if (req.method === 'POST' && url.pathname === '/api/ai/consult') return routes.consult(req, res);
      if (req.method === 'POST' && url.pathname === '/api/events') return routes.createEvent(req, res);
      const match = url.pathname.match(/^\/api\/events\/([a-f0-9-]{36})(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?$/i);
      if (match) {
        const [, id, resource, second, third] = match;
        if (req.method === 'GET' && !resource) return routes.getEvent(req, res, { id });
        if (req.method === 'PATCH' && !resource) return sendResult(res, await routes.patchEvent(req, res, { id, input: await readBody(req) }));
        if (resource === 'assistant') {
          if (req.method === 'POST' && !second) return routes.assistant(req, res, { id, input: await readBody(req) });
          if (req.method === 'GET' && !second) { const history = await eventById(id); return send(res, 200, { conversation: history.conversation || [] }); }
        }
        if (resource === 'actions') {
          if (req.method === 'GET' && !second) return routes.listActions(req, res, { id });
          if (req.method === 'POST' && second && third && ['approve', 'reject'].includes(third)) {
            const outcome = await routes.resolveAction(req, res, { id, actionId: second, decision: third });
            return send(res, 200, {
              status: outcome.status, results: outcome.results, changed: outcome.changed,
              rejected: outcome.rejected || [], event: safeEvent(outcome.event),
              conversation: outcome.event.conversation,
              note: 'Applied changes are recorded on the event; source labels show which came from an accepted AI proposal.'
            });
          }
        }
        if (resource && req.method === 'POST') {
          const result = await routes.postResource(req, res, { id, resource, input: await readBody(req) });
          return sendResult(res, result, result.replay ? 200 : 201);
        }
        if (resource && req.method === 'PATCH') {
          return sendResult(res, await routes.patchResource(req, res, { id, resource, input: await readBody(req) }));
        }
        if (resource && req.method === 'DELETE') {
          return sendResult(res, await routes.deleteResource(req, res, { id, resource, input: await readBody(req) }));
        }
      }
      throw new HttpError(404, 'No such endpoint.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    const requested = path.resolve(PUBLIC, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (!requested.startsWith(PUBLIC + path.sep) && requested !== path.join(PUBLIC, 'index.html')) throw new HttpError(403, 'Forbidden.');
    const entry = staticCache.get(requested);
    if (!entry) throw new HttpError(404, 'Not found.');
    const headers = {
      'content-type': MIME[path.extname(requested)] || 'application/octet-stream',
      'cache-control': 'max-age=0, must-revalidate', 'vary': 'Accept-Encoding', etag: entry.etag, ...SECURITY_HEADERS
    };
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    const variant = staticVariant(entry, req.headers['accept-encoding'] || '');
    if (variant.encoding) headers['content-encoding'] = variant.encoding;
    res.writeHead(200, headers);
    return res.end(variant.payload);
  }

  function sendResult(res, result, status = 200) {
    send(res, status, safeEvent(result.event));
  }

  async function removeUpload(filename) {
    try { const { unlink } = await import('node:fs/promises'); await unlink(path.join(uploadDir, filename)); } catch { /* already gone */ }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      const known = error instanceof HttpError;
      const status = known ? error.status : 400;
      if (!known) console.error('[eventpilot] unexpected error:', error?.stack || error);
      send(res, status >= 500 ? 500 : status, {
        error: status >= 500 ? 'Internal server error. Check the server console.' : (error?.message || 'Request failed.'),
        keepExistingData: true
      });
    });
  });

  return {
    server, store, dataDir: resolvedDataDir, aiSlots,
    listen(port = 0, host = process.env.HOST || '127.0.0.1') {
      const decision = assertSafeDeployment({
        nodeEnv: process.env.NODE_ENV || 'development',
        host,
        persistence: store.kind || 'file',
        accessKey: workspaceSecret
      });
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve({ ...server.address(), ...decision }));
      });
    },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

/**
 * Reads project/.env without overriding variables the shell already set, so a
 * key can live in one local file instead of the command line. No dependency.
 */
function loadEnvFile(rootDir = ROOT) {
  if (typeof process.loadEnvFile !== 'function') return { status: 'unsupported_node' };
  const file = path.join(rootDir, '.env');
  try {
    const before = Object.keys(process.env).length;
    process.loadEnvFile(file);
    return { status: 'loaded', added: Object.keys(process.env).length - before };
  } catch (error) {
    return error?.code === 'ENOENT' ? { status: 'absent' } : { status: 'unreadable', code: error?.code };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvFile();
  const { createDbStore } = await import('./src/db-store.mjs');
  const restUrl = process.env.SUPABASE_REST_URL || '';
  const restKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  // Supabase is used when both halves of its REST endpoint are configured;
  // otherwise the local file store keeps the development demo working.
  const dataDir = process.env.EVENTPILOT_DATA_DIR ? path.resolve(process.env.EVENTPILOT_DATA_DIR) : path.join(ROOT, 'data');
  const store = restUrl && restKey
    ? createDbStore({ restUrl, restKey, table: process.env.SUPABASE_EVENTS_TABLE || 'events' })
    : createStore({ dataDir });
  // dataDir is passed even with the database store: quotation uploads still live
  // on disk and must honour EVENTPILOT_DATA_DIR rather than the repository copy.
  const app = createApp({ store, dataDir });
  const address = await app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
  if (store.ping) await store.ping();
  const keyed = (process.env.EVENTPILOT_ACCESS_KEY || '').trim().length >= 16;
  console.log(`EventPilot AI listening on http://${address.address}:${address.port}`);
  console.log(`  persistence: ${store.kind || 'file'} · workspace key: ${keyed ? 'required' : 'not set (local demo)'}`);
  if (!keyed) console.log('  bound to loopback only. Set EVENTPILOT_ACCESS_KEY and SUPABASE_* to run publicly.');
}
