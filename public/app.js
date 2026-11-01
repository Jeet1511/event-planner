/**
 * EventPilot AI — browser client. No framework, no build step.
 *
 * Three zones: an icon rail, the plan, and a planner rail that is always
 * present. The planner works before an event exists — you can open the page and
 * just start typing — and it keeps working after, with the live plan in context.
 *
 * The composer and rail chrome are static DOM wired once, so a re-render never
 * eats a half-typed message; only the transcript, draft card, proposals and the
 * error banner are re-rendered.
 *
 * Every value interpolated into markup goes through esc().
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
const dateText = value => value ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${value}T12:00:00+05:30`)) : 'Date not set';
const esc = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

let events = [], current = null, view = 'overview', toastTimer;
let dialogReturnFocus = null, activeBackdrop = null;
let draft = null;          // AI extraction awaiting confirmation (manual dialog path)
let pendingPlan = null;    // generated plan awaiting review
let assistantBusy = false;
let proposals = [];        // live AI proposals for the open event
let chatError = null;      // last AI failure, shown in the planner rail
let lastRequest = null;    // { message, focus } so a failed turn can be retried
let countdownTimer = null;
let plannerHistory = [];   // pre-event conversation, held here so the server stays stateless
let plannerDraft = null;   // fields the planner has understood so far
let plannerReady = false;

$('#today').textContent = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date());

async function api(url, options = {}) {
  const init = { ...options };
  if (init.body !== undefined && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
  const result = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.payload = result;
    error.status = response.status;
    throw error;
  }
  return result;
}
function notify(message, tone = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4600);
}

/* ───────────────────────────── navigation ───────────────────────────── */
function showList() {
  current = null; draft = null; chatError = null;
  $('#event-list-view').classList.remove('hidden');
  $('#detail-view').classList.add('hidden');
  $('#page-title').textContent = 'What are we planning?';
  $('#event-meta').textContent = 'Event workspace · India';
  $('#event-subtitle').classList.add('hidden');
  $('#back-events').classList.add('hidden');
  $('#edit-event').classList.add('hidden');
  $('.stage-head').classList.add('landing-mode');
  $$('.rail-btn').forEach(node => node.classList.toggle('active', node.dataset.view === 'overview'));
  renderLanding();
  renderChat();
}
function showDetail(next = view) {
  if (!current) return showList();
  view = ['overview', 'budget', 'timeline', 'vendors', 'guests'].includes(next) ? next : 'overview';
  $('#event-list-view').classList.add('hidden');
  $('#detail-view').classList.remove('hidden');
  $('#page-title').textContent = current.name;
  $('#event-meta').textContent = `${current.type} · ${current.city}`;
  $('#event-subtitle').textContent = `${dateText(current.date)} · ${current.guestsCount ?? current.guests.length} planned guests · ${money(current.budget)} budget`;
  $('#event-subtitle').classList.remove('hidden');
  $('#back-events').classList.remove('hidden');
  $('#edit-event').classList.remove('hidden');
  $('.stage-head').classList.remove('landing-mode');
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  $$('.rail-btn').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  renderDetail();
  renderChat();
}
async function loadProposals() {
  if (!current) return;
  try { proposals = (await api(`/api/events/${current.id}/actions`)).proposals; }
  catch { proposals = []; }
}
/** History is fetched once per event, not on every render or mutation. */
async function loadConversation() {
  if (!current || Array.isArray(current.conversation)) return;
  try { current.conversation = (await api(`/api/events/${current.id}/assistant`)).conversation || []; }
  catch { current.conversation = []; }
}
async function refresh() {
  events = await api('/api/events');
  renderLanding();
  if (current) {
    const found = events.find(event => event.id === current.id);
    if (!found) return showList();
    current = await api(`/api/events/${current.id}`);
    renderDetail();
    renderChat();
  }
}
async function refreshAIHealth() {
  const el = $('#ai-status');
  const dot = $('i', el);
  try {
    const health = await api('/api/health');
    const ai = health.ai || {};
    const label = {
      remote_model_ready: `${shortProvider(ai.provider)} connected`,
      local_model_ready: `${shortProvider(ai.provider)} · local model ready`,
      model_missing: `${shortProvider(ai.provider)} model not installed`,
      no_credentials: 'No AI key · offline templates',
      runtime_unavailable: 'AI offline · templates ready',
      not_configured: 'AI off · templates ready'
    }[ai.status] || 'AI status unknown';
    dot.className = statusTone(ai.status);
    el.title = `${label}. ${ai.detail || `Provider: ${ai.provider || 'none'} · ${ai.status}`}`;
    $('.sr-only', el).textContent = label;
  } catch {
    dot.className = 'bad';
    el.title = 'AI status unavailable';
    $('.sr-only', el).textContent = 'AI status unavailable';
  }
}
const shortProvider = provider => ({ groq: 'Groq', ollama: 'Ollama', gemini: 'Gemini', mock: 'Test AI' }[provider] || 'AI');
const statusTone = status => (status === 'local_model_ready' || status === 'remote_model_ready') ? 'ok' : status === 'model_missing' ? 'warn' : 'bad';

async function openEvent(id) {
  current = await api(`/api/events/${id}`);
  chatError = null;
  await loadConversation();
  await loadProposals();
  showDetail('overview');
}

/* ───────────────────────────── landing ───────────────────────────── */
/** Real totals from the workspace, never sample data. */
function aggregate() {
  const budget = events.reduce((sum, event) => sum + (Number(event.budget) || 0), 0);
  const tasks = events.reduce((sum, event) => sum + (event.taskCount || 0), 0);
  const done = events.reduce((sum, event) => sum + (event.tasksCompleted || 0), 0);
  const guests = events.reduce((sum, event) => sum + (event.guestsCount || 0), 0);
  const soonest = events.map(event => event.date).filter(Boolean).sort()[0] || null;
  const days = soonest ? Math.max(0, Math.round((new Date(`${soonest}T12:00:00+05:30`) - new Date()) / 86_400_000)) : null;
  const byCategory = new Map();
  events.forEach(event => (event.categoryBrief || []).forEach(category => {
    byCategory.set(category.name, (byCategory.get(category.name) || 0) + Number(category.allocation || 0));
  }));
  const splits = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  return { budget, tasks, done, guests, soonest, days, splits, total: splits.reduce((sum, [, value]) => sum + value, 0) };
}
function renderLanding() {
  const grid = $('#events-grid');
  $('#event-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  $('#events-wrap').classList.toggle('hidden', !events.length);
  $('#landing-empty').classList.toggle('hidden', events.length > 0);
  const stats = aggregate();
  const ledger = $('#ledger');
  ledger.classList.toggle('hidden', !events.length);
  if (events.length) {
    ledger.innerHTML = [
      ['Planned across all events', money(stats.budget), true],
      [stats.days === null ? 'No date set yet' : `Until the first date (${dateText(stats.soonest)})`, stats.days === null ? '—' : `${stats.days} days`, false],
      ['Tasks', `${stats.done}/${stats.tasks} done`, false],
      ['People counted', stats.guests.toLocaleString('en-IN'), false]
    ].map(([label, value, accent]) => `<div class="stat${accent ? ' accent' : ''}"><b>${esc(String(value))}</b><span>${esc(label)}</span></div>`).join('');
  }
  const panel = $('#splits-panel');
  panel.classList.toggle('hidden', !stats.splits.length || !stats.total);
  if (stats.splits.length && stats.total) {
    const max = stats.splits[0][1];
    $('#splits').innerHTML = stats.splits.map(([name, value]) => `<div class="split">
      <span>${esc(name)}</span>
      <span class="track"><span style="width:${(value / max * 100).toFixed(1)}%"></span></span>
      <b>${money(value)}</b>
    </div>`).join('');
  }
  if (!events.length) { grid.innerHTML = ''; return; }
  grid.innerHTML = events.map(event => {
    const done = event.tasksCompleted ?? 0;
    const total = event.taskCount ?? 0;
    const percent = total ? Math.round(done / total * 100) : 0;
    const health = event.planHealth || {};
    return `<article class="event-card" data-event="${esc(event.id)}" tabindex="0" role="button" aria-label="Open ${esc(event.name)}">
      <h4>${esc(event.name)}</h4>
      <div class="card-meta">${esc(event.type)} · ${esc(event.city)} · ${dateText(event.date)}</div>
      <div class="track spend"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>
      <div class="card-foot"><span>${done} of ${total} tasks${health.overSpent ? ' · over budget' : health.overdueTasks ? ` · ${health.overdueTasks} overdue` : ''}</span><b>${money(event.budget)}</b></div>
      <div class="badge-row">${badge(event.planSource === 'ai-suggestion' ? 'AI plan' : 'Template plan')}${health.bookingRisk ? badge('Booking at risk', 'amber') : ''}</div>
    </article>`;
  }).join('');
  $$('[data-event]', grid).forEach(card => {
    card.addEventListener('click', () => openEvent(card.dataset.event).catch(error => notify(error.message, 'bad')));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEvent(card.dataset.event).catch(error => notify(error.message, 'bad')); }
    });
  });
}
const badge = (label, tone = '') => `<span class="badge ${tone}">${esc(label)}</span>`;

/* ───────────────────────────── shared panels ───────────────────────────── */
/** The numbers that matter, as one chip row instead of four repeated cards. */
function chips() {
  const health = current.planHealth || {};
  const done = current.tasks.filter(task => task.status === 'completed').length;
  const accepted = current.guests.filter(guest => guest.rsvp === 'accepted').length;
  const list = [
    [`${money(health.allocatedINR)} allocated`, health.overAllocated ? 'alert' : ''],
    [`${money(health.spentINR)} spent · ${health.utilisationPercent}%`, health.overSpent ? 'alert' : ''],
    [`${done}/${current.tasks.length} tasks done`, health.overdueTasks ? 'alert' : done ? 'good' : ''],
    [`${accepted} RSVPs`, '']
  ];
  return list.map(([label, tone]) => `<span class="chip ${tone}">${esc(label)}</span>`).join('');
}
function healthBanner() {
  const health = current.planHealth || {};
  const notes = [];
  if (health.overSpent) notes.push(`Recorded expenses exceed the budget by ${money(Math.abs(health.remainingINR))}.`);
  if (health.overAllocated) notes.push(`Planned allocations exceed the budget by ${money((health.allocatedINR || 0) - (current.budget || 0))}.`);
  if (health.overdueTasks) notes.push(`${health.overdueTasks} task${health.overdueTasks === 1 ? '' : 's'} past due.`);
  if (health.daysToEvent !== null && health.daysToEvent < 45 && (current.vendors || []).every(vendor => vendor.status !== 'booked')) notes.push(`${health.daysToEvent} days to the event with nothing booked yet.`);
  (current.scheduleWarnings || []).forEach(warning => notes.push(esc(warning)));
  if (!notes.length) return '';
  return `<div class="health-banner" role="note"><b>What the plan checks found</b><ul>${notes.map(note => `<li>${note}</li>`).join('')}</ul></div>`;
}
/** Hand-drawn progress ring: one number, no chart library. */
function ring(percent, caption) {
  const radius = 34, circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return `<figure class="ring">
    <svg viewBox="0 0 80 80" width="62" height="62" role="img" aria-label="${Math.round(percent)}% ${esc(caption)}">
      <circle class="ring-bg" cx="40" cy="40" r="${radius}"></circle>
      <circle class="ring-fg" cx="40" cy="40" r="${radius}" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
    </svg>
    <b>${Math.round(percent)}%</b>
    <figcaption>${esc(caption)}</figcaption>
  </figure>`;
}
function budgetRows() {
  const categories = current.categories || [];
  const biggest = Math.max(...categories.map(category => Number(category.allocation) || 0), 1);
  return categories.map(category => {
    const spent = current.expenses.filter(expense => expense.categoryId === category.id).reduce((sum, expense) => sum + expense.amount, 0);
    const share = category.allocation ? Math.min(100, spent / category.allocation * 100) : 0;
    const source = category.source === 'ai-suggestion' ? 'AI proposal' : category.source === 'ai-accepted' ? 'You accepted an AI proposal' : category.source === 'user-entered' ? 'Edited by you' : 'Template';
    return `<div class="budget-row">
      <div><b>${esc(category.name)}</b><small>Spent ${money(spent)} of ${money(category.allocation)} · ${esc(source)}</small>${category.rationale ? `<small class="rationale">${esc(category.rationale)}</small>` : ''}</div>
      <strong>${money(category.allocation)}</strong>
      <div class="track${spent > category.allocation ? ' over' : ' spend'}" title="${share.toFixed(0)}% of this category already spent"><span style="width:${(Number(category.allocation) / biggest * 100).toFixed(1)}%"></span></div>
      <form class="category-edit" data-category-edit="${esc(category.id)}">
        <input name="name" aria-label="Category name" value="${esc(category.name)}" maxlength="60" required>
        <input name="allocation" aria-label="Allocation in INR" type="number" min="0" step="0.01" value="${Number(category.allocation).toFixed(2)}" required>
        <button class="mini-button">Save</button>
        <button class="mini-button danger" type="button" data-category-delete="${esc(category.id)}">Delete</button>
      </form>
    </div>`;
  }).join('') || '<div class="empty-inline">No budget categories yet.</div>';
}

/* ───────────────────────────── views ───────────────────────────── */
function renderOverview() {
  const strategy = current.strategy || {};
  const profile = current.profile || {};
  const done = current.tasks.filter(task => task.status === 'completed').length;
  const percent = current.tasks.length ? done / current.tasks.length * 100 : 0;
  const profileChips = Object.entries(profile).filter(([, values]) => (values || []).length)
    .map(([key, values]) => `<div class="profile-line"><b>${esc(key)}</b><span>${values.map(esc).join(' · ')}</span></div>`).join('');
  return `${healthBanner()}
  <div class="content-grid">
    <div>
      <section class="panel">
        <div class="panel-head"><div><h3>Event strategy</h3><div class="panel-sub">${current.planSource === 'ai-suggestion' ? 'Generated from your brief' : 'Deterministic template — configure an AI provider for a tailored strategy'}</div></div>${badge(current.planSource === 'ai-suggestion' ? 'AI generated' : 'Template')}</div>
        <p class="lede">${esc(strategy.overview || 'No strategy recorded.')}</p>
        <p class="muted"><b>Concept</b> ${esc(strategy.concept || '—')} · <b>Theme</b> ${esc(strategy.theme || '—')}</p>
        ${listBlock('Planning priorities', strategy.priorities)}
        ${listBlock('Watch out for', strategy.challenges)}
        ${listBlock('Recommendations', strategy.recommendations)}
        ${profileChips ? `<div class="profile-chips">${profileChips}</div>` : ''}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Coming up</h3><div class="panel-sub">Nearest deadlines first, spaced by how far apart they really are</div></div><button class="mini-button" data-go="timeline">All tasks</button></div>
        ${timelineRows(4)}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Risks and contingencies</h3><div class="panel-sub">Plan-side checks, not verified facts</div></div></div>
        ${(current.risks || []).length ? current.risks.map(risk => `<div class="risk-row"><b>${esc(risk.risk)}</b><small>${esc(risk.mitigation)}</small></div>`).join('') : '<div class="empty-inline">No risks recorded.</div>'}
        <form class="inline-form" id="risk-form"><input name="risk" aria-label="Risk description" placeholder="New risk" maxlength="240" required><input name="mitigation" aria-label="Mitigation for this risk" placeholder="Mitigation" maxlength="300" required><button class="mini-button">Add risk</button></form>
      </section>
    </div>
    <div>
      <section class="panel">
        <div class="panel-head"><div><h3>How this plan stands</h3><div class="panel-sub">Counted from your records, not from the model</div></div></div>
        <div class="stand">
          ${ring(percent, `${done} of ${current.tasks.length} tasks done`)}
          <div class="ledger">
            <div class="stat accent"><b>${money(current.planHealth?.remainingINR)}</b><span>Still unallocated</span></div>
            <div class="stat"><b>${current.planHealth?.daysToEvent === null || current.planHealth?.daysToEvent === undefined ? 'No date' : `${current.planHealth.daysToEvent} days`}</b><span>${current.date ? `Until ${dateText(current.date)}` : 'Set the date to get deadlines'}</span></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Budget allocation</h3><div class="panel-sub">Bar length is share of the largest category; the darker part is already spent</div></div><button class="mini-button" data-go="budget">Open budget</button></div>
        ${budgetRows()}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Personalised ideas</h3><div class="panel-sub">Suggestions to review</div></div></div>
        ${(current.aiProposal?.ideas || []).length ? current.aiProposal.ideas.map(idea => `<div class="idea"><b>${esc(idea.title)}</b> ${esc(idea.description)}<small>${esc(idea.personalizationReason || '')}</small></div>`).join('')
          : (current.ideas || []).map(idea => `<div class="idea">${esc(idea)}</div>`).join('')}
        <p class="panel-sub">${current.planSource === 'ai-suggestion' ? 'AI suggestions. No vendor, price or availability was verified.' : 'Deterministic template suggestions.'}</p>
      </section>
      <section class="panel">
        <div class="panel-head"><h3>Event details</h3>${badge(current.aiProvider ? `via ${shortProvider(current.aiProvider)}` : 'no provider')}</div>
        <div class="person-row"><div class="task-info"><b>Location</b><small>${esc(current.city)}</small></div></div>
        <div class="person-row"><div class="task-info"><b>Event date</b><small>${dateText(current.date)}</small></div></div>
        <div class="person-row"><div class="task-info"><b>Guests</b><small>${current.guestsCount ?? current.guests.length} planned · ${current.guests.length} added</small></div></div>
        ${current.brief ? `<div class="person-row"><div class="task-info"><b>Your brief</b><small>${esc(current.brief)}</small></div></div>` : ''}
        <p class="panel-sub">Plan model: ${esc(current.aiModel || 'none')} · ${esc((current.aiProposal?.assumptions || []).slice(0, 2).join(' · ') || 'no assumptions recorded')}</p>
      </section>
    </div>
  </div>`;
}
const listBlock = (title, items = []) => (items || []).length ? `<div class="list-block"><b>${esc(title)}</b><ul>${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></div>` : '';

function renderBudget() {
  const health = current.planHealth || {};
  const allocated = Number(health.allocatedINR) || 0;
  const spent = Number(health.spentPaise ?? health.spentINR) || 0;
  return `${healthBanner()}
  <section class="panel">
    <div class="panel-head"><div><h3>Budget intelligence</h3><div class="panel-sub">Allocations are editable. Totals, remaining balance and over-budget warnings are calculated by the application in integer paise — never by the model.</div></div><span class="badge plain">INR</span></div>
    <div class="ledger" style="margin-bottom:var(--space-4)">
      <div class="stat accent"><b>${money(current.budget)}</b><span>Total you set</span></div>
      <div class="stat"><b>${money(health.remainingINR)}</b><span>Still unallocated</span></div>
      <div class="stat"><b>${money(allocated)}</b><span>Planned across categories</span></div>
      <div class="stat"><b>${money(spent)}</b><span>Recorded as spent</span></div>
    </div>
    ${budgetRows()}
    <form class="inline-form" id="category-form"><input name="name" aria-label="New budget category name" placeholder="New category name" maxlength="60" required><input name="allocation" aria-label="New budget category allocation in INR" type="number" min="0" step="0.01" placeholder="Allocation ₹" value="0" required><button class="mini-button">Add category</button></form>
    <form class="inline-form" id="expense-form"><select name="categoryId" aria-label="Budget category">${current.categories.map(category => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('')}</select><input name="description" aria-label="Expense description" placeholder="Expense description" required maxlength="160"><input name="amount" aria-label="Expense amount in INR" type="number" min="0.01" step="0.01" placeholder="Amount ₹" required><button class="mini-button">Add expense</button></form>
    <div class="quick-prompts"><button class="quick" data-focus="budget">Ask the planner to rebalance this budget</button><button class="quick" data-focus="risk">Where is this budget fragile?</button></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h3>Recorded expenses</h3><span class="muted">${current.expenses.length} entries</span></div>
    ${current.expenses.length ? `<table class="table"><thead><tr><th>Description</th><th>Category</th><th>Date</th><th class="right">Amount</th></tr></thead><tbody>${current.expenses.map(expense => `<tr><td>${esc(expense.description)}</td><td>${esc(current.categories.find(category => category.id === expense.categoryId)?.name || '—')}</td><td>${dateText(expense.date)}</td><td class="amount">${money(expense.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-inline">No expenses recorded yet.</div>'}
  </section>`;
}

/**
 * Timeline rows. Items are spaced by the real gap between deadlines, so the
 * list reads as a sequence rather than a table of dates.
 */
function timelineRows(limit = 200) {
  const tasks = [...(current.tasks || [])].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!tasks.length) return '<div class="empty-inline">No tasks yet. Add one below or ask your planner for a plan.</div>';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const dayGap = (from, to) => (!from || !to) ? null : Math.round((new Date(`${to}T12:00:00+05:30`) - new Date(`${from}T12:00:00+05:30`)) / 86_400_000);
  let previous = null;
  return `<div class="timeline">${tasks.slice(0, limit).map(task => {
    const overdue = task.status !== 'completed' && task.dueDate && task.dueDate < today;
    const daysLeft = task.dueDate ? dayGap(today, task.dueDate) : null;
    const gap = previous && task.dueDate ? dayGap(previous, task.dueDate) : null;
    previous = task.dueDate || previous;
    const state = task.status === 'completed' ? 'done' : overdue ? 'late' : daysLeft !== null && daysLeft <= 14 ? 'now' : '';
    const source = task.source === 'ai-suggestion' ? 'from AI' : task.source === 'ai-accepted' ? 'you accepted AI' : task.source === 'template' ? 'template' : 'you added';
    const spacing = gap === null ? 0 : Math.min(34, Math.max(0, Math.round(gap / 3)));
    return `<div class="tl-item ${state}" style="margin-top:${spacing}px">
      <input type="checkbox" data-task="${esc(task.id)}" ${task.status === 'completed' ? 'checked' : ''} aria-label="Mark complete: ${esc(task.title)}">
      <div class="tl-body">
        <b>${esc(task.title)}</b>
        <small>${task.urgency === 'schedule-now' ? 'Schedule now · ' : ''}${esc(source)}${task.dependsOnTitle ? ` · after “${esc(task.dependsOnTitle)}”` : ''}</small>
        ${task.rationale ? `<small class="rationale">${esc(task.rationale)}</small>` : ''}
      </div>
      <div class="tl-when">${task.dueDate ? `<b>${dateText(task.dueDate)}</b>` : '<b>No date</b>'}<span>${overdue ? `${Math.abs(daysLeft)} days overdue` : daysLeft === null ? 'Date to be decided' : daysLeft === 0 ? 'Today' : `in ${daysLeft} days`}</span></div>
      <button class="mini-button danger" data-task-delete="${esc(task.id)}" aria-label="Delete task ${esc(task.title)}">Delete</button>
    </div>`;
  }).join('')}</div>`;
}
function taskRows(limit = 200) {
  const tasks = [...(current.tasks || [])].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!tasks.length) return '<div class="empty-inline">No tasks yet. Add one below or ask your planner for a plan.</div>';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return tasks.slice(0, limit).map(task => {
    const overdue = task.status !== 'completed' && task.dueDate && task.dueDate < today;
    const source = task.source === 'ai-suggestion' ? 'AI' : task.source === 'ai-accepted' ? 'AI accepted' : task.source === 'template' ? 'template' : 'you';
    return `<div class="task-row${overdue ? ' overdue' : ''}">
      <input type="checkbox" data-task="${esc(task.id)}" ${task.status === 'completed' ? 'checked' : ''} aria-label="Mark complete: ${esc(task.title)}">
      <div class="task-info"><b>${esc(task.title)}</b><small>${task.urgency === 'schedule-now' ? 'Schedule now · ' : ''}${task.dueDate ? dateText(task.dueDate) : 'Date to be decided'} · ${esc(task.priority)} priority · ${esc(source)}${overdue ? ' · overdue' : ''}</small>${task.rationale ? `<small class="rationale">${esc(task.rationale)}</small>` : ''}${task.dependsOnTitle ? `<small class="rationale">After: ${esc(task.dependsOnTitle)}</small>` : ''}</div>
      <span class="status ${task.status === 'completed' ? 'completed' : task.priority === 'high' ? 'high' : ''}">${task.status === 'completed' ? 'Done' : task.status === 'in_progress' ? 'In progress' : 'Pending'}</span>
      <button class="mini-button danger" data-task-delete="${esc(task.id)}" aria-label="Delete task ${esc(task.title)}">Delete</button>
    </div>`;
  }).join('');
}
function renderTimeline() {
  const done = current.tasks.filter(task => task.status === 'completed').length;
  const percent = current.tasks.length ? done / current.tasks.length * 100 : 0;
  return `${healthBanner()}
  <section class="panel">
    <div class="panel-head">
      <div><h3>Planning checklist</h3><div class="panel-sub">Deadlines are derived from the event date. When the date changes, open tasks are re-evaluated and any impossible schedule is flagged.</div></div>
      ${ring(percent, `${done} of ${current.tasks.length} done`)}
    </div>
    <form class="inline-form" id="task-form"><input name="title" aria-label="New task title" placeholder="Add a task" maxlength="160" required><input name="dueDate" type="date" aria-label="Due date"><select name="priority" aria-label="Priority"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select><button class="mini-button">Add task</button></form>
    ${timelineRows()}
    <div class="quick-prompts"><button class="quick" data-focus="timeline">Ask the planner to re-plan deadlines</button></div>
  </section>`;
}

function renderVendors() {
  const requirements = current.vendorRequirements || [];
  const longest = Math.max(...requirements.map(item => Number(item.whenBeforeEventDays) || 0), 1);
  return `${healthBanner()}
  <section class="panel">
    <div class="panel-head"><div><h3>Vendor requirements</h3><div class="panel-sub">What to arrange and when. These are categories and lead times, not businesses: the app never invents vendor names, contacts, prices or availability.</div></div><span class="badge plain">${requirements.length} categories</span></div>
    ${requirements.length ? requirements.map(item => `<div class="vendor-row">
      <div class="task-info"><b>${esc(item.category)}</b><small>${esc(item.why || 'Reason not recorded')}</small>${(item.selectionCriteria || []).length ? `<small class="rationale">Checklist: ${item.selectionCriteria.map(esc).join(' · ')}</small>` : ''}
        ${item.whenBeforeEventDays === null || item.whenBeforeEventDays === undefined ? '' : `<span class="track" style="margin-top:8px"><span style="width:${(item.whenBeforeEventDays / longest * 100).toFixed(1)}%"></span></span>`}
      </div>
      <div class="when">${item.whenBeforeEventDays === null || item.whenBeforeEventDays === undefined ? 'No lead time set' : `${item.whenBeforeEventDays} days before`}</div>
      <select class="field" data-vr-status="${esc(item.id)}" aria-label="Status for ${esc(item.category)}">${['to-research', 'enquiring', 'booked', 'not-needed'].map(status => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
      <button class="mini-button danger" data-vr-delete="${esc(item.id)}" aria-label="Remove requirement ${esc(item.category)}">Remove</button>
    </div>`).join('') : '<div class="empty-inline">No requirements yet. Generate a plan or ask your planner.</div>'}
  </section>
  <section class="panel">
    <div class="panel-head"><div><h3>Vendors you found</h3><div class="panel-sub">Only you can confirm a vendor exists, is available and quoted what they said.</div></div><span class="badge plain">${current.vendors.length} records</span></div>
    <form class="inline-form" id="vendor-form"><input name="name" aria-label="Vendor or business name" placeholder="Vendor / business name" required maxlength="100"><input name="category" aria-label="Vendor category" placeholder="Category (e.g. catering)" required maxlength="80"><input name="phone" aria-label="Vendor contact, optional" placeholder="Contact (optional)" maxlength="40"><button class="mini-button">Add vendor</button></form>
    ${current.vendors.length ? current.vendors.map(vendor => `<div class="vendor-row"><div class="task-info"><b>${esc(vendor.name)}</b><small>${esc(vendor.category)} · ${esc(vendor.phone || 'No contact')} · unverified details</small></div>
      <select class="field" data-vendor-status="${esc(vendor.id)}" aria-label="Booking status for ${esc(vendor.name)}">${['enquiring', 'quoted', 'booked', 'cancelled'].map(status => `<option value="${status}" ${vendor.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
      <button class="mini-button danger" data-vendor-delete="${esc(vendor.id)}" aria-label="Delete vendor ${esc(vendor.name)}">Delete</button></div>`).join('') : '<div class="empty-inline">No vendors added yet.</div>'}
  </section>
  <section class="panel">
    <div class="panel-head"><div><h3>Quotation comparison</h3><div class="panel-sub">Amounts are what you entered, not verified market prices. The bar shows each quote against the largest.</div></div></div>
    <form class="inline-form" id="quote-form"><select name="vendorId" aria-label="Vendor" required>${current.vendors.map(vendor => `<option value="${esc(vendor.id)}">${esc(vendor.name)}</option>`).join('')}</select><input name="amount" aria-label="Quotation amount in INR" type="number" min="0" step="0.01" placeholder="Quote amount ₹" required><input name="note" aria-label="What the quotation includes" placeholder="What is included?" maxlength="300"><input name="file" type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Attach quotation"><button class="mini-button" ${current.vendors.length ? '' : 'disabled'}>Add quote</button></form>
    ${current.quotations.length ? (() => {
      const biggest = Math.max(...current.quotations.map(quote => Number(quote.amount) || 0), 1);
      return current.quotations.map(quote => `<div class="split">
        <span>${esc(current.vendors.find(vendor => vendor.id === quote.vendorId)?.name || 'Removed vendor')}</span>
        <span class="track"><span style="width:${(Number(quote.amount) / biggest * 100).toFixed(1)}%"></span></span>
        <b>${money(quote.amount)}</b>
      </div>${quote.note ? `<p class="muted" style="margin-top:-6px">${esc(quote.note)}${quote.file ? ` · file attached (${Math.round(quote.file.size / 1024)} KB)` : ''}</p>` : ''}`).join('');
    })() : '<div class="empty-inline">No quotations recorded.</div>'}
  </section>`;
}

function renderGuests() {
  const accepted = current.guests.filter(guest => guest.rsvp === 'accepted').length;
  const declined = current.guests.filter(guest => guest.rsvp === 'declined').length;
  const pending = current.guests.length - accepted - declined;
  return `
  <section class="panel">
    <div class="panel-head"><div><h3>Guest list</h3><div class="panel-sub">Collect only the contact information you need and are allowed to keep. Contact details stay on this machine and are never sent to an AI provider.</div></div><span class="badge plain">${current.guests.length} guests</span></div>
    ${current.guests.length ? `<div class="splits" style="margin-bottom:var(--space-4)">
      ${[['Accepted', accepted], ['Declined', declined], ['Awaiting reply', pending]].map(([label, value]) => `<div class="split"><span>${label}</span><span class="track"><span style="width:${current.guests.length ? (value / current.guests.length * 100).toFixed(1) : 0}%"></span></span><b>${value}</b></div>`).join('')}
    </div>` : ''}
    <form class="inline-form" id="guest-form"><input name="name" aria-label="Guest name" placeholder="Guest name" required maxlength="100"><input name="contact" aria-label="Guest contact, optional" placeholder="Contact (optional)" maxlength="120"><button class="mini-button">Add guest</button></form>
    ${current.guests.length ? current.guests.map(guest => `<div class="person-row"><div class="task-info"><b>${esc(guest.name)}</b><small>${esc(guest.contact || 'No contact details')}</small></div>
      <select class="field" data-rsvp="${esc(guest.id)}" aria-label="RSVP for ${esc(guest.name)}">${[['pending', 'Pending'], ['accepted', 'Accepted'], ['declined', 'Declined']].map(([value, label]) => `<option value="${value}" ${guest.rsvp === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <button class="mini-button danger" data-guest-delete="${esc(guest.id)}" aria-label="Remove guest ${esc(guest.name)}">Remove</button></div>`).join('') : '<div class="empty-inline">Your guest list will appear here.</div>'}
  </section>`;
}

function renderDetail() {
  if (!current) return;
  $('#event-chips').innerHTML = chips();
  const renderers = { overview: renderOverview, budget: renderBudget, timeline: renderTimeline, vendors: renderVendors, guests: renderGuests };
  $('#detail-content').innerHTML = (renderers[view] || renderOverview)();
  wireDetail();
}

/* ───────────────────────────── planner rail ───────────────────────────── */
function messageRow(entry) {
  const role = entry.role === 'user' ? 'You' : 'Planner';
  const questions = (entry.questions || []).length ? `<div class="questions">${entry.questions.map(question => `<span class="quick" role="note">${esc(question)}</span>`).join('')}</div>` : '';
  return `<div class="msg ${entry.role}"><span class="who">${esc(role)}</span><p>${esc(entry.content)}</p>
    ${questions}
    ${entry.impact ? `<div class="impact">${esc(entry.impact)}</div>` : ''}
    ${entry.rejected?.length ? `<div class="rejected">Skipped ${entry.rejected.length} proposed change(s): ${entry.rejected.map(item => esc(item.error)).join(' · ')}</div>` : ''}
    ${entry.actionStatus === 'applied' ? '<div class="applied">Proposal applied.</div>' : ''}</div>`;
}
function proposalCard(proposal) {
  const check = proposal.deterministicCheck;
  return `<div class="proposal" data-proposal="${esc(proposal.id)}">
    <div class="proposal-head"><b>Change proposal</b><span>expires ${esc(new Date(proposal.expiresAt).toLocaleTimeString('en-IN'))}</span></div>
    ${proposal.impact ? `<p class="muted">${esc(proposal.impact)}</p>` : ''}
    <ul class="action-list">${proposal.actions.map(action => `<li>${esc(action.label)}</li>`).join('')}</ul>
    ${check ? `<div class="check"><span class="label">Money effect, calculated here</span><table class="table compact"><thead><tr><th></th><th class="right">Allocated</th><th class="right">Spent</th><th class="right">Remaining</th></tr></thead><tbody>
      <tr><td>Now</td><td class="right">${money(check.before.allocatedINR)}</td><td class="right">${money(check.before.spentINR)}</td><td class="right">${money(check.before.remainingINR)}</td></tr>
      <tr><td>After</td><td class="right">${money(check.after.allocatedINR)}</td><td class="right">${money(check.after.spentINR)}</td><td class="right">${money(check.after.remainingINR)}</td></tr></tbody></table>
      ${check.overAllocated ? '<div class="rejected">Warning: this leaves allocations above your total budget.</div>' : ''}${check.overSpent ? '<div class="rejected">Warning: this leaves recorded spend above your total budget.</div>' : ''}</div>` : ''}
    ${proposal.screening?.warnings?.length ? `<div class="rejected">${proposal.screening.warnings.map(esc).join(' · ')}</div>` : ''}
    ${proposal.rejected?.length ? `<div class="rejected">Not applicable: ${proposal.rejected.map(item => esc(`${item.op} — ${item.error}`)).join(' · ')}</div>` : ''}
    <div class="proposal-actions"><button class="button primary" data-approve="${esc(proposal.id)}">Approve &amp; apply</button><button class="button secondary" data-reject="${esc(proposal.id)}">Dismiss</button></div>
  </div>`;
}
/** What the planner has understood so far. Optional action, never a gate. */
function draftCard() {
  const fields = plannerDraft || {};
  const rows = [
    ['Event', fields.name || null],
    ['Type', fields.type || null],
    ['City', fields.city || null],
    ['Date', fields.date ? dateText(fields.date) : null],
    ['Guests', fields.guests ? String(fields.guests) : null],
    ['Budget', fields.budget ? money(fields.budget) : null]
  ];
  return `<div class="draft-card">
    <b>What I have so far</b>
    ${rows.map(([label, value]) => `<div class="row${value ? '' : ' gap'}"><span>${esc(label)}</span><b>${value ? esc(value) : 'not yet'}</b></div>`).join('')}
    ${plannerReady
      ? '<button class="button primary" id="draft-plan">Create my plan</button><span class="muted">Or keep talking — nothing is saved yet.</span>'
      : '<span class="muted">Tell me the rest whenever you like, or use “Enter details” to fill it in.</span>'}
  </div>`;
}
function errorBanner(error) {
  const countdown = error.retryAfterSeconds ? ` <span data-countdown="${error.retryAfterSeconds}">Retry in ${error.retryAfterSeconds}s.</span>` : '';
  return `<div>
    <div><b>${esc(error.title)}</b> ${esc(error.message)}${countdown}</div>
    ${error.cause ? `<div class="muted">${esc(error.cause)}</div>` : ''}
    <div class="retry-row"><button class="button secondary" id="chat-retry">Try again</button><span class="muted">Nothing was changed.</span></div>
  </div>`;
}
/** Only the rail's dynamic parts re-render, so the composer keeps its text. */
function renderChat() {
  clearInterval(countdownTimer);
  const open = Boolean(current);
  const talking = open || plannerHistory.length > 0;
  $('#chat-intro').classList.toggle('hidden', talking);
  $('#chat-scroll').classList.toggle('hidden', !talking);
  $('#planner-sub').textContent = open
    ? `Reading ${current.name}’s plan as it stands now. Nothing changes until you approve it.`
    : 'Talk it through in your own words. Nothing changes until you approve it.';
  $('#planner-fab').classList.toggle('hidden', !talking || $('.planner').classList.contains('open'));
  const messages = open ? (current.conversation || []) : plannerHistory;
  const pending = open ? proposals.filter(proposal => proposal.status === 'pending') : [];
  $('#transcript').innerHTML = `${messages.length ? messages.map(messageRow).join('') : `<div class="empty-inline">Ask for a change — “cut the budget to 6 lakh”, “the photographer cancelled”, “add 50 guests”.</div>`}
    ${assistantBusy ? '<div class="typing" role="status"><i></i><i></i><i></i><i></i><i></i><span>Thinking…</span></div>' : ''}`;
  $('#chat-draft').innerHTML = open ? '' : (plannerHistory.length ? draftCard() : '');
  $('#chat-proposals').innerHTML = pending.map(proposalCard).join('');
  const errorSlot = $('#chat-error');
  errorSlot.innerHTML = chatError ? errorBanner(chatError) : '';
  errorSlot.classList.toggle('hidden', !chatError);
  const send = $('#assistant-send');
  send.disabled = assistantBusy;
  send.textContent = assistantBusy ? 'Thinking…' : 'Send';
  $('#assistant-input').disabled = assistantBusy;
  $('#assistant-input').placeholder = open
    ? 'Ask about this event, or describe a change…'
    : 'Describe the event in your own words…';
  renderQuickPrompts(open);
  wireChat();
  const scroll = $('#chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
  if (chatError?.retryAfterSeconds) startCountdown(chatError.retryAfterSeconds);
}
const QUICK_OPEN = ['My budget has decreased', 'We are inviting more guests', 'A vendor just cancelled', 'Make it more elegant without more money'];
const QUICK_NEW = ['Birthday for my younger brother, about 30 people, not too expensive', 'A wedding for 250 guests in Pune next December', 'A community feast in Kolkata this winter'];
function renderQuickPrompts(open) {
  const prompts = open ? QUICK_OPEN : QUICK_NEW;
  const box = $('#quick-prompts');
  box.innerHTML = prompts.map(prompt => `<button class="quick" type="button">${esc(prompt)}</button>`).join('');
  $$('.quick', box).forEach(button => button.addEventListener('click', () => {
    const input = $('#assistant-input');
    input.value = button.textContent;
    input.focus();
  }));
}
function startCountdown(seconds) {
  let left = seconds;
  countdownTimer = setInterval(() => {
    left -= 1;
    const node = $('[data-countdown]');
    if (!node || left <= 0) { clearInterval(countdownTimer); if (node) node.textContent = 'You can retry now.'; return; }
    node.textContent = `Retry in ${left}s.`;
  }, 1000);
}
function wireChat() {
  $$('#chat-proposals [data-approve]').forEach(button => button.addEventListener('click', () => resolveProposal(button.dataset.approve, 'approve')));
  $$('#chat-proposals [data-reject]').forEach(button => button.addEventListener('click', () => resolveProposal(button.dataset.reject, 'reject')));
  $('#draft-plan')?.addEventListener('click', () => {
    const fields = plannerDraft || {};
    generatePlan({
      name: fields.name || 'New event', type: fields.type, city: fields.city, date: fields.date || '',
      guests: Number(fields.guests) || 0, budget: Number(fields.budget) || 0,
      brief: plannerHistory.filter(item => item.role === 'user').map(item => item.content).join('\n').slice(0, 4000),
      profile: { style: fields.style || [], priorities: fields.priorities || [] }
    });
  });
  $('#chat-retry')?.addEventListener('click', () => {
    const request = lastRequest;
    chatError = null;
    renderChat();
    if (request) sendToPlanner(request);
  });
}

/* ───────────────────────────── wiring ───────────────────────────── */
/**
 * A mutation response already carries everything a card shows, so the list is
 * patched in place instead of re-downloading every event after every checkbox.
 */
function mergeIntoList(event) {
  const tasks = event.tasks || [];
  const card = {
    id: event.id, name: event.name, type: event.type, city: event.city, date: event.date,
    budget: event.budget, currency: event.currency, guestsCount: event.guestsCount,
    planSource: event.planSource, aiProvider: event.aiProvider,
    taskCount: tasks.length, tasksCompleted: tasks.filter(task => task.status === 'completed').length,
    taskBrief: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, dueDate: task.dueDate, priority: task.priority })),
    categoryBrief: (event.categories || []).map(category => ({ name: category.name, allocation: category.allocation })),
    summary: event.summary, planHealth: event.planHealth
  };
  const index = events.findIndex(item => item.id === event.id);
  if (index >= 0) events[index] = card; else events.unshift(card);
  renderLanding();
}
async function saveTo(url, payload, method = 'POST') {
  current = await api(url, { method, body: JSON.stringify(payload) });
  renderDetail();
  mergeIntoList(current);
  return current;
}
async function refreshList() { events = await api('/api/events'); renderLanding(); }

async function submitForm(event, url) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  if (form.id === 'expense-form') data.idempotencyKey = form.dataset.idempotencyKey || crypto.randomUUID();
  if (data.file instanceof File) {
    if (data.file.size > 5 * 1024 * 1024) return notify('Quotation file must be under 5 MB.', 'bad');
    if (data.file.size) data.fileData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read quotation file.'));
      reader.readAsDataURL(data.file);
    });
    delete data.file;
  }
  try {
    await saveTo(url, data);
    if (form.id === 'expense-form') form.dataset.idempotencyKey = crypto.randomUUID();
    notify('Saved.', 'ok');
  } catch (error) { notify(error.message, 'bad'); }
}

/**
 * One entry point for both planner modes. With an event open it runs a revision
 * turn; without one it runs the free-text intake. Neither requires the user to
 * have picked anything first.
 */
async function sendToPlanner({ message = '', focus = null }) {
  if (assistantBusy || !message.trim() && !focus) return;
  assistantBusy = true;
  lastRequest = { message, focus };
  chatError = null;
  // The pre-event transcript is held here; the server stays stateless.
  const history = current ? null : plannerHistory.slice();
  if (!current) plannerHistory.push({ role: 'user', content: message });
  renderChat();
  try {
    if (current) {
      const result = await api(`/api/events/${current.id}/assistant`, { method: 'POST', body: { message, focus } });
      current = result.event;
      if (result.conversation) current.conversation = result.conversation;
      await loadProposals();
      mergeIntoList(current);
      if (result.proposal) notify(`Proposal ready: ${result.proposal.actions.length} change(s) awaiting your approval.`, 'ok');
      else if (result.screening?.blockers?.length) notify(`Your plan checks blocked the planner's changes: ${result.screening.blockers.join(' ')} Nothing was applied.`, 'bad');
      else if (result.rejected?.length) notify('The planner answered, but none of its proposed changes were applicable.', 'warn');
      else notify('The planner answered.', 'ok');
    } else {
      const result = await api('/api/ai/consult', { method: 'POST', body: { message, history, draft: plannerDraft || {} } });
      plannerHistory.push({ role: 'assistant', content: result.reply, questions: result.questions });
      plannerDraft = result.fields;
      plannerReady = result.ready;
      if (plannerReady) notify('Your planner has enough to build a first plan.', 'ok');
    }
  } catch (error) {
    if (error.payload?.event) current = error.payload.event;
    const payload = error.payload || {};
    chatError = {
      title: error.status === 429 ? 'Rate limited.' : 'The planner could not answer.',
      message: error.message,
      cause: payload.cause || null,
      retryAfterSeconds: payload.retryAfterSeconds ?? null
    };
    notify(error.message, 'bad');
  } finally {
    assistantBusy = false;
    renderChat();
    $('#assistant-input').focus();
  }
}

function wireDetail() {
  $$('[data-go]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.go)));
  $$('[data-focus]').forEach(button => button.addEventListener('click', () => sendToPlanner({ focus: button.dataset.focus })));
  $$('[data-task]').forEach(box => box.addEventListener('change', async () => {
    try { await saveTo(`/api/events/${current.id}/tasks`, { id: box.dataset.task, status: box.checked ? 'completed' : 'pending' }, 'PATCH'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-task-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Delete this task?')) return;
    try { await saveTo(`/api/events/${current.id}/tasks`, { id: button.dataset.taskDelete }, 'DELETE'); notify('Task deleted.'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-rsvp]').forEach(select => select.addEventListener('change', async () => {
    try { await saveTo(`/api/events/${current.id}/guests`, { id: select.dataset.rsvp, rsvp: select.value }, 'PATCH'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-guest-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Remove this guest?')) return;
    try { await saveTo(`/api/events/${current.id}/guests`, { id: button.dataset.guestDelete }, 'DELETE'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-vendor-status]').forEach(select => select.addEventListener('change', async () => {
    try { await saveTo(`/api/events/${current.id}/vendors`, { id: select.dataset.vendorStatus, status: select.value }, 'PATCH'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-vendor-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Delete this vendor record?')) return;
    try { await saveTo(`/api/events/${current.id}/vendors`, { id: button.dataset.vendorDelete }, 'DELETE'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-vr-status]').forEach(select => select.addEventListener('change', async () => {
    try { await saveTo(`/api/events/${current.id}/vendor-requirements`, { id: select.dataset.vrStatus, status: select.value }, 'PATCH'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-vr-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Remove this vendor requirement?')) return;
    try { await saveTo(`/api/events/${current.id}/vendor-requirements`, { id: button.dataset.vrDelete }, 'DELETE'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-category-edit]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.id = form.dataset.categoryEdit;
    data.allocation = Number(data.allocation);
    try { await saveTo(`/api/events/${current.id}/categories`, data, 'PATCH'); notify('Budget category updated.', 'ok'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  $$('[data-category-delete]').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Delete this budget category?')) return;
    try { await saveTo(`/api/events/${current.id}/categories`, { id: button.dataset.categoryDelete }, 'DELETE'); notify('Budget category deleted.', 'ok'); }
    catch (error) { notify(error.message, 'bad'); }
  }));
  const forms = { 'expense-form': 'expenses', 'category-form': 'categories', 'task-form': 'tasks', 'vendor-form': 'vendors', 'guest-form': 'guests', 'quote-form': 'quotations', 'risk-form': 'risks' };
  Object.entries(forms).forEach(([id, resource]) => {
    const form = $(`#${id}`);
    if (form) form.addEventListener('submit', event => submitForm(event, `/api/events/${current.id}/${resource}`));
  });
}
async function resolveProposal(actionId, decision) {
  try {
    const result = await api(`/api/events/${current.id}/actions/${actionId}/${decision}`, { method: 'POST', body: {} });
    current = result.event;
    if (result.conversation) current.conversation = result.conversation;
    await loadProposals();
    renderDetail();
    renderChat();
    mergeIntoList(current);
    const failed = (result.results || []).filter(item => !item.ok).length;
    notify(decision === 'approve'
      ? `Applied ${(result.results || []).length - failed} change(s)${failed ? `, ${failed} could not be applied` : ''}.`
      : 'Proposal dismissed. Your plan is unchanged.', decision === 'approve' && failed ? 'warn' : 'ok');
  } catch (error) { notify(error.message, 'bad'); await loadProposals(); renderChat(); }
}

/* ───────────────────────────── dialogs ───────────────────────────── */
function openDialog(backdrop) {
  dialogReturnFocus = document.activeElement;
  activeBackdrop = backdrop;
  backdrop.classList.remove('hidden');
  const first = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])', backdrop)
    .find(node => node.offsetParent !== null && !node.classList.contains('icon-button'));
  (first || $('button', backdrop))?.focus();
}
function closeDialog() {
  if (!activeBackdrop) return;
  activeBackdrop.classList.add('hidden');
  activeBackdrop = null;
  dialogReturnFocus?.focus?.();
}
document.addEventListener('keydown', event => {
  if (!activeBackdrop) return;
  if (event.key === 'Escape') { event.preventDefault(); closeDialog(); return; }
  if (event.key !== 'Tab') return;
  const items = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])', activeBackdrop)
    .filter(node => node.offsetParent !== null);
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$$('.backdrop').forEach(backdrop => backdrop.addEventListener('click', event => { if (event.target === backdrop) closeDialog(); }));

function openCreate(mode = 'describe', editMode = false) {
  draft = null;
  $('#extraction').classList.add('hidden');
  $('#extraction').innerHTML = '';
  $('#understand-status').textContent = '';
  setMode(mode);
  $('#create-title').textContent = 'Create an event';
  $('#create-backdrop').dataset.edit = '';
  if (editMode && current) {
    const form = $('#mode-manual');
    form.elements.name.value = current.name;
    form.elements.city.value = current.city;
    form.elements.date.value = current.date || '';
    form.elements.type.value = current.type;
    form.elements.guests.value = current.guestsCount ?? current.guests.length;
    form.elements.budget.value = current.budget;
    form.elements.type.disabled = true;
    form.elements.guests.disabled = true;
    form.elements.budget.disabled = true;
    $('#create-title').textContent = 'Edit event details';
    $('#create-backdrop').dataset.edit = 'true';
    setMode('manual');
  } else {
    $$('#mode-manual :is(input, select)').forEach(node => { node.disabled = false; });
  }
  openDialog($('#create-backdrop'));
}
function setMode(mode) {
  $$('.seg').forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#mode-describe').classList.toggle('hidden', mode !== 'describe');
  $('#mode-manual').classList.toggle('hidden', mode !== 'manual');
}
$$('.seg').forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
$('#close-create').addEventListener('click', closeDialog);
$('#cancel-create').addEventListener('click', closeDialog);
$('#new-event').addEventListener('click', () => {
  if (current) { showList(); }
  $('#assistant-input').focus();
});
// The landing's primary action is the conversation; the form stays available.
$('#hero-create').addEventListener('click', () => {
  const input = $('#assistant-input');
  input.focus();
  input.setSelectionRange(0, 0);
  if (window.matchMedia('(max-width: 900px)').matches) setPlannerOpen(true);
});
$('#manual-create').addEventListener('click', () => openCreate('describe'));
$('#edit-event').addEventListener('click', () => openCreate('describe', true));

/* AI intake, manual dialog path */
$('#understand-btn').addEventListener('click', async () => {
  const brief = $('#brief').value.trim();
  const status = $('#understand-status');
  if (brief.length < 12) { status.textContent = 'Write a sentence or two first.'; return; }
  $('#understand-btn').disabled = true;
  status.textContent = 'Reading your brief…';
  try {
    const result = await api('/api/ai/understand', { method: 'POST', body: { brief } });
    draft = result;
    status.textContent = `Extracted by ${shortProvider(result.provider)}. Check anything marked “not from your brief”, then answer the questions.`;
    renderExtraction();
  } catch (error) {
    draft = null;
    status.textContent = `${error.message} You can still enter the details manually.`;
    $$('.seg')[1].click();
  } finally { $('#understand-btn').disabled = false; }
});

function renderExtraction() {
  const box = $('#extraction');
  const extraction = draft.extraction;
  const fields = extraction.fields;
  const flag = key => (extraction.unconfirmed || []).includes(key);
  const questions = extraction.followUpQuestions || [];
  box.innerHTML = `
    <div class="extract-grid">
      <label class="field-label">Event name<input data-field="name" value="${esc(fields.name)}" maxlength="100"></label>
      <label class="field-label">Type${flag('event type') ? '<em class="ask">not in your brief</em>' : ''}<select data-field="type"><option value="">Choose</option>${['wedding', 'birthday', 'community'].map(value => `<option value="${value}" ${fields.type === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label class="field-label">City${flag('city') ? '<em class="ask">not in your brief</em>' : ''}<input data-field="city" value="${esc(fields.city)}" maxlength="80"></label>
      <label class="field-label">Date${flag('event date') ? '<em class="ask">not in your brief</em>' : ''}<input data-field="date" type="date" value="${esc(fields.date || '')}"></label>
      <label class="field-label">Guests${flag('guest count') ? '<em class="ask">not in your brief</em>' : ''}<input data-field="guests" type="number" min="0" max="100000" value="${fields.guests ?? ''}"></label>
      <label class="field-label">Budget (INR)${flag('budget') ? '<em class="ask">not in your brief</em>' : ''}<input data-field="budget" type="number" min="0" step="0.01" value="${fields.budget ?? ''}"></label>
    </div>
    ${extraction.summary ? `<p class="lede">${esc(extraction.summary)}</p>` : ''}
    ${(extraction.assumptions || []).length ? listBlock('Assumptions', extraction.assumptions) : ''}
    ${questions.length ? `<div class="questions"><b>Before I plan — ${questions.length} question${questions.length === 1 ? '' : 's'}</b>${questions.map((item, index) => `<div class="question"><label>Question ${index + 1}: ${esc(item.question)}<input data-answer="${index}" placeholder="Type your answer (optional)"></label><small>${esc(item.whyItMatters)}</small></div>`).join('')}</div>` : ''}
    <button type="button" class="button primary" id="plan-from-draft">Generate my plan</button>`;
  box.classList.remove('hidden');
  $('#plan-from-draft').addEventListener('click', () => {
    const answers = $$('[data-answer]', box).map(input => input.value.trim()).filter(Boolean);
    if (answers.length) draft.brief = `${draft.brief}\n\nFollow-up answers: ${answers.join(' | ')}`;
    const payload = draftPayload();
    if (payload.error) return notify(payload.error, 'bad');
    generatePlan(payload);
  });
}
function draftPayload() {
  const read = field => $(`[data-field="${field}"]`, $('#extraction'))?.value?.trim?.() ?? '';
  const payload = {
    name: read('name') || 'New event',
    type: read('type'),
    city: read('city'),
    date: read('date'),
    guests: Number(read('guests')),
    budget: Number(read('budget')),
    brief: draft.brief,
    profile: draft.extraction.profile
  };
  if (!payload.type) return { error: 'Choose the event type — it was not clear from your brief.' };
  if (payload.city.length < 2) return { error: 'Enter the city — it was not clear from your brief.' };
  if (!Number.isInteger(payload.guests) || payload.guests < 0) return { error: 'Enter a whole number of guests.' };
  if (!Number.isFinite(payload.budget) || payload.budget < 0) return { error: 'Enter a budget in INR.' };
  return payload;
}

async function generatePlan(input) {
  const button = $('#save-review');
  try {
    $('#draft-plan')?.setAttribute('disabled', '');
    $('#understand-status').textContent = 'Building your plan…';
    const plan = await api('/api/plan', { method: 'POST', body: input });
    pendingPlan = { plan, input };
    renderReview(plan, input);
    closeDialog();
    openDialog($('#review-backdrop'));
  } catch (error) { notify(error.message, 'bad'); }
  finally { $('#draft-plan')?.removeAttribute('disabled'); $('#plan-from-draft')?.removeAttribute('disabled'); button.disabled = false; }
}

function renderReview(plan, input) {
  const source = plan.aiGenerated ? `${shortProvider(plan.aiProvider)} proposal` : 'deterministic template';
  $('#review-eyebrow').textContent = 'Review before saving';
  $('#review-title').textContent = `${input.name} — ${source}`;
  const rows = (items, columns) => items.length ? `<table class="table compact"><thead><tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead><tbody>${items.map(item => `<tr>${columns.map(column => `<td>${item[column]}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<div class="empty-inline">None returned.</div>';
  const strategy = plan.strategy || {};
  const categoryRows = plan.categories.map(category => ({
    Category: esc(category.name),
    'Share %': category.sharePercent !== undefined ? esc(category.sharePercent) : '—',
    Amount: money(category.allocation),
    Why: esc(category.rationale || '—')
  }));
  const taskList = plan.categories.length ? plan.tasks.map(task => `<tr><td>${esc(task.title)}</td><td>${task.dueDate ? dateText(task.dueDate) : 'No date'}</td><td>${esc(task.priority)}</td><td>${esc(task.rationale || '')}</td></tr>`).join('') : '';
  $('#review-body').innerHTML = `
    <div class="provenance ${plan.aiGenerated ? 'ai' : 'template'}">
      <b>${plan.aiGenerated ? 'AI-generated suggestion' : 'Deterministic template'}</b>
      <p>${plan.aiGenerated
        ? 'The model proposed these shares, deadlines and ideas. No vendor identity, price, availability or permission has been verified. Totals are calculated by the application.'
        : `No structured AI output was available (${esc(plan.aiDetail || 'provider not configured')}), so this plan came from the built-in templates. You can still save it and ask your planner later.`}${plan.aiCause ? ` <span class="muted">(${esc(plan.aiCause)})</span>` : ''}</p>
    </div>
    <h4>Strategy</h4><p class="lede">${esc(strategy.overview || '')}</p>
    <p class="muted"><b>Concept</b> ${esc(strategy.concept || '—')} · <b>Theme</b> ${esc(strategy.theme || '—')}</p>
    ${listBlock('Priorities', strategy.priorities)}${listBlock('Challenges', strategy.challenges)}${listBlock('Recommendations', strategy.recommendations)}
    <h4>Budget · ${money(plan.event.budget)} total</h4>${rows(categoryRows, ['Category', 'Share %', 'Amount', 'Why'])}
    <p class="muted">Sum of allocations: ${money(plan.categories.reduce((sum, category) => sum + category.allocation, 0))}</p>
    <h4>Timeline · ${plan.tasks.length} tasks</h4>
    ${plan.tasks.length ? `<table class="table compact"><thead><tr><th>Task</th><th>By</th><th>Priority</th><th>Why</th></tr></thead><tbody>${taskList}</tbody></table>` : '<div class="empty-inline">No tasks returned.</div>'}
    ${plan.scheduleWarnings?.length ? `<div class="rejected">${plan.scheduleWarnings.map(esc).join(' · ')}</div>` : ''}
    <h4>Vendor requirements</h4>
    ${(plan.vendorRequirements || []).length ? `<table class="table compact"><thead><tr><th>Category</th><th>Why</th><th>When</th><th>Checklist</th></tr></thead><tbody>${plan.vendorRequirements.map(item => `<tr><td>${esc(item.category)}</td><td>${esc(item.why || '—')}</td><td>${item.whenBeforeEventDays === null || item.whenBeforeEventDays === undefined ? '—' : `${item.whenBeforeEventDays} days before`}</td><td>${(item.selectionCriteria || []).map(esc).join(' · ') || '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-inline">No vendor requirements returned.</div>'}
    <h4>Ideas</h4><ul>${(plan.ideas || []).map(idea => `<li>${esc(idea)}</li>`).join('')}</ul>
    <h4>Risks</h4>${(plan.risks || []).length ? plan.risks.map(risk => `<div class="risk-row"><b>${esc(risk.risk)}</b><small>${esc(risk.mitigation)}</small></div>`).join('') : '<div class="empty-inline">No risks returned.</div>'}
    ${(plan.assumptions || []).length ? listBlock('Assumptions', plan.assumptions) : ''}
    ${(plan.missingInformation || []).length ? listBlock('Still missing', plan.missingInformation) : ''}`;
}
$('#close-review').addEventListener('click', closeDialog);
$('#discard-review').addEventListener('click', () => { pendingPlan = null; closeDialog(); notify('Plan discarded. Nothing was saved.'); });
$('#save-review').addEventListener('click', async () => {
  if (!pendingPlan) return closeDialog();
  const button = $('#save-review');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    const input = { ...pendingPlan.input, proposalId: pendingPlan.plan.proposalId || undefined, profile: pendingPlan.input.profile };
    current = await api('/api/events', { method: 'POST', body: input });
    closeDialog();
    await refreshList();
    chatError = null;
    plannerHistory = []; plannerDraft = null; plannerReady = false;
    await loadConversation();
    await loadProposals();
    showDetail('overview');
    notify('Plan saved to your workspace.', 'ok');
    pendingPlan = null;
  } catch (error) { notify(error.message, 'bad'); }
  finally { button.disabled = false; button.textContent = 'Save this plan'; }
});

$('#mode-manual').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('#create-backdrop').dataset.edit === 'true') {
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      current = await api(`/api/events/${current.id}`, { method: 'PATCH', body: JSON.stringify({ name: data.name, city: data.city, date: data.date }) });
      closeDialog();
      await refreshList();
      renderDetail();
      notify('Event details updated.', 'ok');
    } catch (error) { notify(error.message, 'bad'); }
    return;
  }
  const input = Object.fromEntries(new FormData(event.currentTarget).entries());
  input.guests = Number(input.guests);
  input.budget = Number(input.budget);
  generatePlan(input);
});

/* ───────────────────────────── planner rail chrome ───────────────────────────── */
$('#assistant-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#assistant-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  sendToPlanner({ message });
});
// Enter sends, Shift+Enter adds a line — the same contract as the hint text.
$('#assistant-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey) {
    event.preventDefault();
    event.currentTarget.closest('form').requestSubmit();
  }
});

function setPlannerOpen(open) {
  $('.planner').classList.toggle('open', open);
  const fab = $('#planner-fab');
  fab.setAttribute('aria-expanded', String(open));
  if (open) $('#assistant-input').focus();
  renderChat();
}
$('#planner-close').addEventListener('click', () => setPlannerOpen(false));
$('#planner-fab').addEventListener('click', () => setPlannerOpen(true));

$('#back-events').addEventListener('click', showList);
$$('.rail-btn').forEach(button => button.addEventListener('click', () => {
  if (current) showDetail(button.dataset.view);
  else if (button.dataset.view === 'overview') showList();
  else notify('Create or open an event first.', 'warn');
}));
$$('.tab').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.view)));

try { await refresh(); } catch (error) { notify(`Could not load local data: ${error.message}`, 'bad'); }
refreshAIHealth();
renderChat();
