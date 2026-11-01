/**
 * EventPilot AI — browser client. No framework, no build step.
 * Renders the AI intake, plan review, planning assistant and the deterministic
 * panels. Every value interpolated into markup goes through esc().
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(value) || 0);
const dateText = value => value ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(`${value}T12:00:00+05:30`)) : 'Date not set';
const esc = (value = '') => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

let events = [], current = null, view = 'overview', toastTimer;
let dialogReturnFocus = null, activeBackdrop = null;
let draft = null;          // AI extraction awaiting confirmation
let pendingPlan = null;    // generated plan awaiting review
let assistantBusy = false;
let proposals = [];        // live AI proposals for the open event

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
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

/* ───────────────────────────── navigation ───────────────────────────── */
function showList() {
  current = null; draft = null;
  $('#event-list-view').classList.remove('hidden');
  $('#detail-view').classList.add('hidden');
  $('#page-title').textContent = 'Your events';
  $$('.nav').forEach(node => node.classList.toggle('active', node.dataset.view === 'overview'));
  renderEvents();
}
function showDetail(next = view) {
  if (!current) return showList();
  view = next;
  $('#event-list-view').classList.add('hidden');
  $('#detail-view').classList.remove('hidden');
  $('#page-title').textContent = current.name;
  $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  $$('.nav').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  if (view === 'assistant') loadProposals().finally(renderDetail);
  else renderDetail();
}
async function loadProposals() {
  if (!current) return;
  try { proposals = (await api(`/api/events/${current.id}/actions`)).proposals; }
  catch { proposals = []; }
}
async function refresh() {
  events = await api('/api/events');
  renderEvents();
  if (current) {
    const found = events.find(event => event.id === current.id);
    if (!found) return showList();
    current = await api(`/api/events/${current.id}`);
    renderDetail();
  }
}
async function refreshAIHealth() {
  const el = $('#ai-status');
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
    el.innerHTML = `<i aria-hidden="true" class="${statusTone(ai.status)}"></i> ${esc(label)}`;
    el.title = ai.detail || `Provider: ${ai.provider || 'none'} · ${ai.status}`;
  } catch {
    el.innerHTML = '<i aria-hidden="true" class="bad"></i> AI status unavailable';
  }
}
const shortProvider = provider => ({ groq: 'Groq', ollama: 'Ollama', gemini: 'Gemini', mock: 'Test AI' }[provider] || 'AI');
const statusTone = status => (status === 'local_model_ready' || status === 'remote_model_ready') ? 'ok' : status === 'model_missing' ? 'warn' : 'bad';

async function openEvent(id) {
  current = await api(`/api/events/${id}`);
  showDetail('overview');
}

/* ───────────────────────────── event list ───────────────────────────── */
function renderEvents() {
  const grid = $('#events-grid');
  $('#event-count').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  if (!events.length) {
    grid.innerHTML = '<div class="empty-card"><div class="empty-icon" aria-hidden="true">✦</div><h3>No events yet</h3><p>Describe an event in plain words and the assistant will build the first plan.</p></div>';
    return;
  }
  grid.innerHTML = events.map(event => {
    const done = event.tasks.filter(task => task.status === 'completed').length;
    const percent = event.tasks.length ? Math.round(done / event.tasks.length * 100) : 0;
    const health = event.planHealth || {};
    return `<article class="event-card" data-event="${esc(event.id)}" tabindex="0" role="button" aria-label="Open ${esc(event.name)}">
      <div class="event-icon" aria-hidden="true">${event.type === 'wedding' ? '♧' : event.type === 'birthday' ? '✦' : '⌂'}</div>
      <h3>${esc(event.name)}</h3>
      <div class="card-meta">${esc(event.type)} · ${esc(event.city)} · ${dateText(event.date)}</div>
      <div class="progress-track"><span style="width:${Math.max(0, Math.min(100, percent))}%"></span></div>
      <div class="card-foot"><span>${done}/${event.tasks.length} tasks${health.overSpent ? ' · over budget' : health.overdueTasks ? ` · ${health.overdueTasks} overdue` : ''}</span><b>${money(event.budget)}</b></div>
      <div class="badge-row">${badge(event.planSource === 'ai-suggestion' ? 'AI plan' : 'Template plan')}${health.bookingRisk ? badge('Booking at risk', 'amber') : ''}</div>
    </article>`;
  }).join('');
  $$('[data-event]', grid).forEach(card => {
    card.addEventListener('click', () => openEvent(card.dataset.event).catch(error => notify(error.message)));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEvent(card.dataset.event).catch(error => notify(error.message)); }
    });
  });
}
const badge = (label, tone = '') => `<span class="badge ${tone}">${esc(label)}</span>`;

/* ───────────────────────────── shared panels ───────────────────────────── */
function metrics() {
  const health = current.planHealth || {};
  const done = current.tasks.filter(task => task.status === 'completed').length;
  const accepted = current.guests.filter(guest => guest.rsvp === 'accepted').length;
  return `<div class="metrics">
    <div class="metric"><label>Total budget</label><strong>${money(health.allocatedINR !== undefined ? current.budget : current.summary.total)}</strong><small>${esc(current.type)} · ${esc(current.city)}</small></div>
    <div class="metric"><label>Allocated</label><strong>${money(health.allocatedINR)}</strong><small>${health.overAllocated ? 'Above total budget' : 'Planned across categories'}</small></div>
    <div class="metric"><label>Spent so far</label><strong>${money(health.spentINR)}</strong><small>${health.utilisationPercent}% of budget recorded</small></div>
    <div class="metric"><label>Tasks completed</label><strong>${done}/${current.tasks.length}</strong><small>${health.overdueTasks ? `${health.overdueTasks} overdue · ` : ''}${accepted} RSVPs</small></div>
  </div>`;
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
  return `<div class="health-banner" role="note"><b>Plan checks</b><ul>${notes.map(note => `<li>${note}</li>`).join('')}</ul></div>`;
}
function budgetRows() {
  return (current.categories || []).map(category => {
    const spent = current.expenses.filter(expense => expense.categoryId === category.id).reduce((sum, expense) => sum + expense.amount, 0);
    const percent = category.allocation ? Math.min(100, spent / category.allocation * 100) : 0;
    const source = category.source === 'ai-suggestion' ? 'AI proposal' : category.source === 'ai-accepted' ? 'You accepted an AI proposal' : category.source === 'user-entered' ? 'Edited by you' : 'Template';
    return `<div class="budget-row">
      <div><b>${esc(category.name)}</b><small>Spent ${money(spent)} of ${money(category.allocation)} · ${esc(source)}</small>${category.rationale ? `<small class="rationale">${esc(category.rationale)}</small>` : ''}</div>
      <strong>${money(category.allocation)}</strong>
      <div class="progress-track"><span style="width:${percent.toFixed(1)}%;${spent > category.allocation ? 'background:var(--red)' : ''}"></span></div>
      <form class="category-edit" data-category-edit="${esc(category.id)}">
        <input name="name" aria-label="Category name" value="${esc(category.name)}" maxlength="60" required>
        <input name="allocation" aria-label="Allocation in INR" type="number" min="0" step="0.01" value="${Number(category.allocation).toFixed(2)}" required>
        <button class="mini-button">Save</button>
        <button class="mini-button" type="button" data-category-delete="${esc(category.id)}">Delete</button>
      </form>
    </div>`;
  }).join('') || '<div class="empty-inline">No budget categories yet.</div>';
}

/* ───────────────────────────── views ───────────────────────────── */
function renderOverview() {
  const strategy = current.strategy || {};
  const profile = current.profile || {};
  const profileChips = Object.entries(profile).filter(([, values]) => (values || []).length)
    .map(([key, values]) => `<div class="profile-line"><b>${esc(key)}</b><span>${values.map(esc).join(' · ')}</span></div>`).join('');
  return `${metrics()}${healthBanner()}
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
        <div class="panel-head"><div><h3>Next actions</h3><div class="panel-sub">Sorted by deadline</div></div><button class="mini-button" data-go="timeline">All tasks</button></div>
        ${taskRows(5)}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Risks and contingencies</h3><div class="panel-sub">Plan-side checks, not verified facts</div></div></div>
        ${(current.risks || []).length ? current.risks.map(risk => `<div class="risk-row"><b>${esc(risk.risk)}</b><small>${esc(risk.mitigation)}</small></div>`).join('') : '<div class="empty-inline">No risks recorded.</div>'}
        <form class="inline-form" id="risk-form"><input name="risk" aria-label="Risk description" placeholder="New risk" maxlength="240" required><input name="mitigation" aria-label="Mitigation for this risk" placeholder="Mitigation" maxlength="300" required><button class="mini-button">＋ Add risk</button></form>
      </section>
    </div>
    <div>
      <section class="panel">
        <div class="panel-head"><div><h3>Planning assistant</h3><div class="panel-sub">Ask it to change anything; you approve each edit</div></div></div>
        <div class="quick-prompts">
          ${['My budget has changed', 'We are inviting more guests', 'A vendor just cancelled', 'Make it more elegant without more money'].map(prompt => `<button class="quick" data-quick="${esc(prompt)}">${esc(prompt)}</button>`).join('')}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Budget allocation</h3><div class="panel-sub">INR · totals computed by the app</div></div><button class="mini-button" data-go="budget">View budget</button></div>
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

function renderAssistant() {
  const conversation = current.conversation || [];
  const pending = proposals.filter(proposal => proposal.status === 'pending');
  return `${metrics()}
  <div class="content-grid">
    <div>
      <section class="panel assistant-panel">
        <div class="panel-head"><div><h3>Planning assistant</h3><div class="panel-sub">Reads this event’s live plan. Changes are proposals — nothing is applied without your approval.</div></div>${badge(current.aiProvider ? shortProvider(current.aiProvider) : 'no provider')}</div>
        <div class="transcript" id="transcript" aria-live="polite" aria-relevant="additions">
          ${conversation.length ? conversation.map(entry => messageRow(entry)).join('') : '<div class="empty-inline">No conversation yet. Ask for a change — “cut the budget to 6 lakh”, “the photographer cancelled”, “add 50 guests”.</div>'}
          ${assistantBusy ? '<div class="typing" role="status">Thinking about your plan…</div>' : ''}
        </div>
        <form class="assistant-form" id="assistant-form">
          <label class="sr-only" for="assistant-input">Message the planning assistant</label>
          <textarea id="assistant-input" name="message" rows="2" maxlength="3000" placeholder="Ask about this event, or describe a change… Enter sends, Shift+Enter adds a line." ${assistantBusy ? 'disabled' : ''}></textarea>
          <button class="button primary" type="submit" ${assistantBusy ? 'disabled' : ''}>${assistantBusy ? 'Thinking…' : 'Send ✦'}</button>
        </form>
        <div class="quick-prompts">
          ${['My budget has decreased to 6 lakh', 'We are inviting 50 more guests', 'The photographer cancelled', 'Make it more elegant without increasing the budget'].map(prompt => `<button class="quick" data-quick="${esc(prompt)}">${esc(prompt)}</button>`).join('')}
        </div>
      </section>
    </div>
    <div>
      <section class="panel">
        <div class="panel-head"><div><h3>Proposals awaiting you</h3><div class="panel-sub">Approve to apply, dismiss to discard. Unapproved proposals are held in server memory only.</div></div><span class="badge">${pending.length} pending</span></div>
        ${pending.length ? pending.map(proposalCard).join('') : '<div class="empty-inline">Nothing pending. Ask the assistant for a change and it will show up here.</div>'}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h3>Revise one section</h3><div class="panel-sub">Targeted revision: only the named part of the plan is re-generated</div></div></div>
        <div class="quick-prompts">
          ${[['budget', 'Re-plan the budget'], ['timeline', 'Re-plan the timeline'], ['vendors', 'Re-plan vendor needs'], ['ideas', 'More ideas'], ['risk', 'Find new risks']].map(([focus, label]) => `<button class="quick" data-focus="${focus}">${esc(label)}</button>`).join('')}
        </div>
      </section>
    </div>
  </div>`;
}
function messageRow(entry) {
  const role = entry.role === 'user' ? 'You' : 'Assistant';
  return `<div class="msg ${entry.role}"><b>${esc(role)}</b><p>${esc(entry.content)}</p>
    ${entry.impact ? `<div class="impact">Impact: ${esc(entry.impact)}</div>` : ''}
    ${entry.rejected?.length ? `<div class="rejected">Skipped ${entry.rejected.length} proposed change(s): ${entry.rejected.map(item => esc(item.error)).join(' · ')}</div>` : ''}
    ${entry.actionStatus === 'applied' ? '<div class="applied">Proposal applied.</div>' : ''}</div>`;
}
function proposalCard(proposal) {
  const check = proposal.deterministicCheck;
  return `<div class="proposal" data-proposal="${esc(proposal.id)}">
    <div class="proposal-head"><b>Change proposal</b><span class="muted">${esc(new Date(proposal.createdAt).toLocaleString('en-IN'))} · expires ${esc(new Date(proposal.expiresAt).toLocaleTimeString('en-IN'))}</span></div>
    ${proposal.impact ? `<p class="muted">${esc(proposal.impact)}</p>` : ''}
    <ul class="action-list">${proposal.actions.map(action => `<li>${esc(action.label)}</li>`).join('')}</ul>
    ${check ? `<div class="check"><b>Money effect (calculated here, not by the model)</b><table class="table compact"><thead><tr><th></th><th>Allocated</th><th>Spent</th><th>Remaining</th></tr></thead><tbody>
      <tr><td>Now</td><td>${money(check.before.allocatedINR)}</td><td>${money(check.before.spentINR)}</td><td>${money(check.before.remainingINR)}</td></tr>
      <tr><td>After</td><td>${money(check.after.allocatedINR)}</td><td>${money(check.after.spentINR)}</td><td>${money(check.after.remainingINR)}</td></tr></tbody></table>
      ${check.overAllocated ? '<div class="rejected">Warning: this leaves allocations above your total budget.</div>' : ''}${check.overSpent ? '<div class="rejected">Warning: this leaves recorded spend above your total budget.</div>' : ''}</div>` : ''}
    ${proposal.screening?.warnings?.length ? `<div class="rejected">${proposal.screening.warnings.map(esc).join(' · ')}</div>` : ''}
    ${proposal.rejected?.length ? `<div class="rejected">Not applicable: ${proposal.rejected.map(item => esc(`${item.op} — ${item.error}`)).join(' · ')}</div>` : ''}
    <div class="proposal-actions"><button class="button primary" data-approve="${esc(proposal.id)}">Approve &amp; apply</button><button class="button secondary" data-reject="${esc(proposal.id)}">Dismiss</button></div>
  </div>`;
}

function renderBudget() {
  return `${metrics()}${healthBanner()}
  <section class="panel">
    <div class="panel-head"><div><h3>Budget intelligence</h3><div class="panel-sub">Allocations are editable. Totals, remaining balance and over-budget warnings are calculated by the application in integer paise.</div></div><span class="badge">INR</span></div>
    ${budgetRows()}
    <form class="inline-form" id="category-form"><input name="name" aria-label="New budget category name" placeholder="New category name" maxlength="60" required><input name="allocation" aria-label="New category allocation in INR" type="number" min="0" step="0.01" placeholder="Allocation ₹" value="0" required><button class="mini-button">＋ Add category</button></form>
    <form class="inline-form" id="expense-form"><select name="categoryId" aria-label="Budget category">${current.categories.map(category => `<option value="${esc(category.id)}">${esc(category.name)}</option>`).join('')}</select><input name="description" aria-label="Expense description" placeholder="Expense description" required maxlength="160"><input name="amount" aria-label="Expense amount in INR" type="number" min="0.01" step="0.01" placeholder="Amount ₹" required><button class="mini-button">＋ Add expense</button></form>
    <div class="quick-prompts"><button class="quick" data-focus="budget">Ask the AI to rebalance this budget</button><button class="quick" data-focus="risk">Where is this budget fragile?</button></div>
  </section>
  <section class="panel">
    <div class="panel-head"><h3>Recorded expenses</h3><span class="muted">${current.expenses.length} entries</span></div>
    ${current.expenses.length ? `<table class="table"><thead><tr><th>DESCRIPTION</th><th>CATEGORY</th><th>DATE</th><th>AMOUNT</th></tr></thead><tbody>${current.expenses.map(expense => `<tr><td>${esc(expense.description)}</td><td>${esc(current.categories.find(category => category.id === expense.categoryId)?.name || '—')}</td><td>${dateText(expense.date)}</td><td class="amount">${money(expense.amount)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty-inline">No expenses recorded yet.</div>'}
  </section>`;
}

function taskRows(limit = 200) {
  const tasks = [...(current.tasks || [])].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  if (!tasks.length) return '<div class="empty-inline">No tasks yet. Add one below or ask the assistant for a plan.</div>';
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
  return `${metrics()}${healthBanner()}
  <section class="panel">
    <div class="panel-head"><div><h3>Planning checklist</h3><div class="panel-sub">Deadlines are derived from the event date. When the date changes, open tasks are re-evaluated and any impossible schedule is flagged.</div></div><span class="badge">${current.tasks.filter(task => task.status === 'completed').length} / ${current.tasks.length} done</span></div>
    <form class="inline-form" id="task-form"><input name="title" aria-label="New task title" placeholder="Add a task" maxlength="160" required><input name="dueDate" type="date" aria-label="Due date"><select name="priority" aria-label="Priority"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select><button class="mini-button">＋ Add task</button></form>
    ${taskRows()}
    <div class="quick-prompts"><button class="quick" data-focus="timeline">Ask the AI to re-plan deadlines</button></div>
  </section>`;
}

function renderVendors() {
  const requirements = current.vendorRequirements || [];
  return `${metrics()}${healthBanner()}
  <section class="panel">
    <div class="panel-head"><div><h3>Vendor requirements</h3><div class="panel-sub">What to arrange and when. These are categories and lead times, not businesses: the app never invents vendor names, contacts, prices or availability.</div></div><span class="badge">${requirements.length} categories</span></div>
    ${requirements.length ? requirements.map(item => `<div class="vendor-row">
      <div class="task-info"><b>${esc(item.category)}</b><small>${esc(item.why || 'Reason not recorded')}</small>${(item.selectionCriteria || []).length ? `<small class="rationale">Checklist: ${item.selectionCriteria.map(esc).join(' · ')}</small>` : ''}</div>
      <div class="when">${item.whenBeforeEventDays === null || item.whenBeforeEventDays === undefined ? 'No lead time set' : `Arrange ${item.whenBeforeEventDays} days before`}</div>
      <select class="field" data-vr-status="${esc(item.id)}" aria-label="Status for ${esc(item.category)}">${['to-research', 'enquiring', 'booked', 'not-needed'].map(status => `<option value="${status}" ${item.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
      <button class="mini-button danger" data-vr-delete="${esc(item.id)}" aria-label="Remove requirement ${esc(item.category)}">Remove</button>
    </div>`).join('') : '<div class="empty-inline">No requirements yet. Generate a plan or ask the assistant.</div>'}
  </section>
  <section class="panel">
    <div class="panel-head"><div><h3>Vendors you found</h3><div class="panel-sub">Only you can confirm a vendor exists, is available and quoted what they said.</div></div><span class="badge">${current.vendors.length} records</span></div>
    <form class="inline-form" id="vendor-form"><input name="name" aria-label="Vendor or business name" placeholder="Vendor / business name" required maxlength="100"><input name="category" aria-label="Vendor category" placeholder="Category (e.g. catering)" required maxlength="80"><input name="phone" aria-label="Vendor contact, optional" placeholder="Contact (optional)" maxlength="40"><button class="mini-button">＋ Add vendor</button></form>
    ${current.vendors.length ? current.vendors.map(vendor => `<div class="vendor-row"><div class="event-icon" aria-hidden="true">⌂</div><div class="task-info"><b>${esc(vendor.name)}</b><small>${esc(vendor.category)} · ${esc(vendor.phone || 'No contact')} · unverified details</small></div>
      <select class="field" data-vendor-status="${esc(vendor.id)}" aria-label="Booking status for ${esc(vendor.name)}">${['enquiring', 'quoted', 'booked', 'cancelled'].map(status => `<option value="${status}" ${vendor.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select>
      <button class="mini-button danger" data-vendor-delete="${esc(vendor.id)}" aria-label="Delete vendor ${esc(vendor.name)}">Delete</button></div>`).join('') : '<div class="empty-inline">No vendors added yet.</div>'}
  </section>
  <section class="panel">
    <div class="panel-head"><div><h3>Quotation comparison</h3><div class="panel-sub">Amounts are what you entered, not verified market prices.</div></div></div>
    <form class="inline-form" id="quote-form"><select name="vendorId" aria-label="Vendor" required>${current.vendors.map(vendor => `<option value="${esc(vendor.id)}">${esc(vendor.name)}</option>`).join('')}</select><input name="amount" aria-label="Quotation amount in INR" type="number" min="0" step="0.01" placeholder="Quote amount ₹" required><input name="note" aria-label="What the quotation includes" placeholder="What is included?" maxlength="300"><input name="file" type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Attach quotation"><button class="mini-button" ${current.vendors.length ? '' : 'disabled'}>＋ Add quote</button></form>
    ${current.quotations.length ? `<table class="table"><thead><tr><th>VENDOR</th><th>AMOUNT</th><th>DETAILS</th><th>SOURCE</th></tr></thead><tbody>${current.quotations.map(quote => `<tr><td>${esc(current.vendors.find(vendor => vendor.id === quote.vendorId)?.name || 'Removed vendor')}</td><td>${money(quote.amount)}</td><td>${esc(quote.note || '—')}${quote.file ? ` · file attached (${Math.round(quote.file.size / 1024)} KB)` : ''}</td><td>Unverified</td></tr>`).join('')}</tbody></table>` : '<div class="empty-inline">No quotations recorded.</div>'}
  </section>`;
}

function renderGuests() {
  return `${metrics()}
  <section class="panel">
    <div class="panel-head"><div><h3>Guest list</h3><div class="panel-sub">Collect only the contact information you need and are allowed to keep. Contact details stay on this machine and are never sent to an AI provider.</div></div><span class="badge">${current.guests.length} guests</span></div>
    <form class="inline-form" id="guest-form"><input name="name" aria-label="Guest name" placeholder="Guest name" required maxlength="100"><input name="contact" aria-label="Guest contact, optional" placeholder="Contact (optional)" maxlength="120"><button class="mini-button">＋ Add guest</button></form>
    ${current.guests.length ? current.guests.map(guest => `<div class="person-row"><div class="event-icon" aria-hidden="true">♧</div><div class="task-info"><b>${esc(guest.name)}</b><small>${esc(guest.contact || 'No contact details')}</small></div>
      <select class="field" data-rsvp="${esc(guest.id)}" aria-label="RSVP for ${esc(guest.name)}">${[['pending', 'Pending'], ['accepted', 'Accepted'], ['declined', 'Declined']].map(([value, label]) => `<option value="${value}" ${guest.rsvp === value ? 'selected' : ''}>${label}</option>`).join('')}</select>
      <button class="mini-button danger" data-guest-delete="${esc(guest.id)}" aria-label="Remove guest ${esc(guest.name)}">Remove</button></div>`).join('') : '<div class="empty-inline">Your guest list will appear here.</div>'}
  </section>`;
}

function renderDetail() {
  if (!current) return;
  $('#event-meta').textContent = `${current.type.toUpperCase()} · ${current.city.toUpperCase()}`;
  $('#event-name').textContent = current.name;
  $('#event-subtitle').textContent = `${dateText(current.date)} · ${current.guestsCount ?? current.guests.length} planned guests · ${money(current.budget)} budget`;
  const renderers = { overview: renderOverview, assistant: renderAssistant, budget: renderBudget, timeline: renderTimeline, vendors: renderVendors, guests: renderGuests };
  $('#detail-content').innerHTML = (renderers[view] || renderOverview)();
  wireDetail();
  const transcript = $('#transcript');
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

/* ───────────────────────────── wiring ───────────────────────────── */
async function saveTo(url, payload, method = 'POST') {
  current = await api(url, { method, body: JSON.stringify(payload) });
  renderDetail();
  await refreshList();
  return current;
}
async function refreshList() { events = await api('/api/events'); renderEvents(); }

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

async function sendAssistant({ message = '', focus = null }) {
  if (assistantBusy) return;
  assistantBusy = true;
  renderDetail();
  try {
    const result = await api(`/api/events/${current.id}/assistant`, { method: 'POST', body: { message, focus } });
    current = result.event;
    await loadProposals();
    renderDetail();
    await refreshList();
    if (result.proposal) notify(`Proposal ready: ${result.proposal.actions.length} change(s) awaiting your approval.`, 'ok');
    else if (result.screening?.blockers?.length) notify(`Your plan checks blocked the assistant's changes: ${result.screening.blockers.join(' ')} Nothing was applied.`, 'bad');
    else if (result.rejected?.length) notify('The assistant answered, but none of its proposed changes were applicable.', 'warn');
    else notify('The assistant answered.', 'ok');
  } catch (error) {
    if (error.payload?.event) current = error.payload.event;
    renderDetail();
    notify(error.message, 'bad');
  } finally { assistantBusy = false; }
}

function wireDetail() {
  $$('[data-go]').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.go)));
  $$('[data-quick]').forEach(button => button.addEventListener('click', () => {
    const input = $('#assistant-input');
    if (input) { input.value = button.dataset.quick; input.focus(); }
    sendAssistant({ message: button.dataset.quick });
  }));
  $$('[data-focus]').forEach(button => button.addEventListener('click', () => sendAssistant({ focus: button.dataset.focus })));
  $$('#assistant-form').forEach(form => form.addEventListener('submit', event => {
    event.preventDefault();
    const message = new FormData(form).get('message');
    form.reset();
    sendAssistant({ message });
  }));
  // Enter sends, Shift+Enter adds a line — the same contract as the textarea's own help text.
  $$('#assistant-input').forEach(input => input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      event.currentTarget.closest('form').requestSubmit();
    }
  }));
  $$('[data-approve]').forEach(button => button.addEventListener('click', () => resolveProposal(button.dataset.approve, 'approve')));
  $$('[data-reject]').forEach(button => button.addEventListener('click', () => resolveProposal(button.dataset.reject, 'reject')));
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
    await loadProposals();
    renderDetail();
    await refreshList();
    const failed = (result.results || []).filter(item => !item.ok).length;
    notify(decision === 'approve'
      ? `Applied ${ (result.results || []).length - failed } change(s)${failed ? `, ${failed} could not be applied` : ''}.`
      : 'Proposal dismissed. Your plan is unchanged.', decision === 'approve' && failed ? 'warn' : 'ok');
  } catch (error) { notify(error.message, 'bad'); await loadProposals(); renderDetail(); }
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
$('#new-event').addEventListener('click', () => openCreate('describe'));
$('#hero-create').addEventListener('click', () => openCreate('describe'));
$('#edit-event').addEventListener('click', () => openCreate('describe', true));

/* AI intake */
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
    <button type="button" class="button primary" id="plan-from-draft">Generate my plan ✦</button>`;
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
    $('#plan-from-draft')?.setAttribute('disabled', '');
    $('#understand-status').textContent = 'Building your plan…';
    const plan = await api('/api/plan', { method: 'POST', body: input });
    pendingPlan = { plan, input };
    renderReview(plan, input);
    closeDialog();
    openDialog($('#review-backdrop'));
  } catch (error) { notify(error.message, 'bad'); }
  finally { $('#plan-from-draft')?.removeAttribute('disabled'); button.disabled = false; }
}

function renderReview(plan, input) {
  const source = plan.aiGenerated ? `${shortProvider(plan.aiProvider)} proposal` : 'deterministic template';
  $('#review-eyebrow').textContent = 'REVIEW BEFORE SAVING';
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
        : `No structured AI output was available (${esc(plan.aiDetail || 'provider not configured')}), so this plan came from the built-in templates. You can still save it and ask the assistant later.`}</p>
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

$('#back-events').addEventListener('click', showList);
$$('.nav').forEach(button => button.addEventListener('click', () => {
  if (current) showDetail(button.dataset.view);
  else if (button.dataset.view === 'overview') showList();
  else notify('Create or open an event first.');
}));
$$('.tab').forEach(button => button.addEventListener('click', () => showDetail(button.dataset.view)));

try { await refresh(); } catch (error) { notify(`Could not load local data: ${error.message}`, 'bad'); }
refreshAIHealth();
