import test from 'node:test';
import assert from 'node:assert/strict';
import { sharesToPaise, resolveSchedule, normalizeAction, applyActions, analyzeImpact, budgetView, perGuestCatering, plannedGuests, eventFingerprint, RUPEE } from '../src/planning.mjs';

/** Mirrors the persisted shape: `guests` is the guest LIST, `guestsCount` the number. */
const event = () => ({
  id: 'e1', name: 'Ananya wedding', type: 'wedding', city: 'Kolkata', date: '2027-02-01',
  guestsCount: 250, budget: 800000, currency: 'INR',
  categories: [
    { id: 'cat-venue', name: 'Venue', allocation: 240000 },
    { id: 'cat-food', name: 'Catering', allocation: 320000 }
  ],
  tasks: [{ id: 'task-1', title: 'Confirm venue', status: 'pending', dueDate: '2026-11-03', priority: 'high', source: 'ai-suggestion' }],
  expenses: [{ id: 'x1', description: 'Venue advance', amount: 50000, categoryId: 'cat-venue', date: '2026-06-01' }],
  vendors: [{ id: 'ven-1', name: 'Sample Hall', category: 'Venue', status: 'enquiring' }],
  vendorRequirements: [], guests: [{ id: 'g1', name: 'Guest One', rsvp: 'accepted' }], quotations: [], conversation: []
});

test('planned guest count survives both the list shape and the pre-persist shape', () => {
  assert.equal(plannedGuests(event()), 250);
  assert.equal(plannedGuests({ guests: 120 }), 120);
  assert.equal(plannedGuests({ guests: [], guestsCount: 0 }), 0);
  assert.equal(perGuestCatering({ ...event(), categories: [{ id: 'cat-food', name: 'Catering', allocation: 320000 }], expenses: [] }), 1280);
});

test('budget shares convert to paise exactly without dumping the residue on one line', () => {
  const paise = sharesToPaise(100000_00, [33.33, 33.33, 33.34]);
  assert.equal(paise.reduce((sum, value) => sum + value, 0), 100000_00);
  const rupees = paise.map(RUPEE);
  assert.ok(rupees.every(value => value > 33300 && value < 33400), `unexpected spread: ${rupees.join(',')}`);
  const thirds = sharesToPaise(1_00, [33.3333, 33.3333, 33.3334]);
  assert.equal(thirds.reduce((sum, value) => sum + value, 0), 100);
  assert.ok(thirds.every(value => value <= 34), `no single line absorbs the remainder: ${thirds.join(',')}`);
});

test('schedule clamps overdue dates to today and reports dependency conflicts', () => {
  const soon = '2026-11-10';
  const { tasks, warnings } = resolveSchedule([
    { title: 'Confirm venue', relativeDeadlineDays: 90, priority: 'high' },
    { title: 'Finalise decoration', relativeDeadlineDays: 30, priority: 'medium', dependsOnTitle: 'Confirm venue' }
  ], soon, '2026-11-01');
  assert.equal(tasks[0].dueDate, '2026-11-01');
  assert.equal(tasks[0].urgency, 'schedule-now');
  assert.equal(tasks[1].dueDate, '2026-11-01', 'both clamp to today when the event is imminent');
  assert.ok(warnings.length >= 1, `dependency conflict must be reported: ${warnings.join('|')}`);
  const roomy = resolveSchedule([
    { title: 'Confirm venue', relativeDeadlineDays: 90, priority: 'high' },
    { title: 'Finalise decoration', relativeDeadlineDays: 30, priority: 'medium', dependsOnTitle: 'Confirm venue' }
  ], '2027-06-01', '2026-11-01');
  assert.ok(roomy.tasks[0].dueDate < roomy.tasks[1].dueDate, 'venue must precede decoration');
  assert.deepEqual(roomy.warnings, []);
});

test('undated tasks and tasks without a dependency stay untouched', () => {
  const { tasks } = resolveSchedule([{ title: 'No date', relativeDeadlineDays: null }, { title: 'Keep', relativeDeadlineDays: 10 }], null, '2026-11-01');
  assert.equal(tasks[0].dueDate, null);
  assert.equal(tasks[0].urgency, 'undated');
  assert.equal(tasks[1].dueDate, null, 'a relative deadline with no event date cannot be resolved');
});

test('normalizeAction rejects invented ids, bad money and impossible dates', () => {
  const base = event();
  assert.match(normalizeAction({ op: 'update_task', taskId: 'nope', status: 'completed' }, base).error, /not part of this event/);
  assert.match(normalizeAction({ op: 'remove_task', taskId: 'nope' }, base).error, /not part of this event/);
  assert.match(normalizeAction({ op: 'update_event', field: 'budget', value: '-5' }, base).error, /non-negative/);
  assert.match(normalizeAction({ op: 'update_event', field: 'budget', value: '1e12' }, base).error, /non-negative/);
  assert.match(normalizeAction({ op: 'update_event', field: 'guests', value: 45.5 }, base).error, /whole number/);
  assert.match(normalizeAction({ op: 'update_event', field: 'date', value: '2027-02-31' }, base).error, /real YYYY-MM-DD/);
  assert.match(normalizeAction({ op: 'set_budget_allocation', categoryId: 'nope', allocationINR: 100 }, base).error, /not part of this event/);
  assert.match(normalizeAction({ op: 'hack_the_planet' }, base).error, /Unsupported/);
  assert.match(normalizeAction({ op: 'add_tasks', tasks: [{ title: 'Confirm venue', relativeDeadlineDays: 5 }] }, base).error, /already exist/);
  assert.match(normalizeAction({ op: 'update_event', field: 'guests', value: 5_000_000 }, base).error, /100,000/);
  assert.ok(normalizeAction({ op: 'add_tasks', tasks: [{ title: 'New job', relativeDeadlineDays: 5, priority: 'high' }] }, base).tasks.length === 1);
});

test('an allocation can never be pushed below what has already been spent', () => {
  const base = event();
  const result = normalizeAction({ op: 'set_budget_allocation', categoryId: 'cat-venue', allocationINR: 10000 }, base);
  assert.match(result.error, /has 50000\.00 INR recorded; allocation cannot be lower/);
  assert.equal(normalizeAction({ op: 'set_budget_allocation', categoryId: 'cat-venue', allocationINR: 60000 }, base).allocationINR, 60000);
});

test('applying an approved proposal changes only what it names', () => {
  const base = event();
  const userTask = { id: 'task-user', title: 'Personal errand', status: 'pending', dueDate: '2026-12-01', priority: 'low', source: 'user' };
  base.tasks.push(userTask);
  const applied = applyActions(base, [
    { op: 'update_event', field: 'budget', value: 600000 },
    { op: 'update_event', field: 'guests', value: 300 },
    { op: 'add_tasks', tasks: [{ title: 'Renegotiate catering', description: 'Reduce per-plate', relativeDeadlineDays: 60, priority: 'high', rationale: 'Largest line' }] },
    { op: 'add_vendor_requirement', category: 'Decoration', why: 'Cheaper styling', whenBeforeEventDays: 30, priority: 'medium', selectionCriteria: ['Itemised quote'] },
    { op: 'remove_task', taskId: 'task-1' },
    { op: 'update_vendor_status', vendorId: 'ven-1', status: 'booked' }
  ], { now: new Date('2026-11-01T10:00:00Z') });
  assert.ok(applied.results.every(result => result.ok), JSON.stringify(applied.results));
  assert.equal(base.budget, 600000);
  assert.equal(base.guestsCount, 300);
  assert.ok(Array.isArray(base.guests) && base.guests.length === 1, 'the guest list must survive a guest-count change');
  assert.equal(base.tasks.length, 2);
  assert.equal(base.tasks.find(task => task.id === 'task-user').dueDate, '2026-12-01', 'the user task is untouched');
  assert.equal(base.vendors[0].status, 'booked');
  assert.equal(base.vendorRequirements.length, 1);
  assert.equal(base.vendorRequirements[0].source, 'ai-accepted');
  assert.deepEqual(applied.changed.sort(), ['event', 'timeline', 'vendors']);
});

test('budget maths stays exact in paise and flags over-allocation and overspend', () => {
  const view = budgetView(event());
  assert.equal(view.totalPaise, 800000_00);
  assert.equal(view.allocatedPaise, 560000_00);
  assert.equal(view.spentPaise, 50000_00);
  assert.equal(view.unallocatedPaise, 240000_00);
  assert.equal(view.overAllocated, false);
  const over = budgetView({ ...event(), budget: 100000 });
  assert.equal(over.overAllocated, true);
  assert.equal(over.overSpent, false);
  const spent = budgetView({ ...event(), budget: 40000 });
  assert.equal(spent.overSpent, true);
  assert.equal(spent.remainingPaise, -10000_00);
});

test('impact analysis blocks impossible changes and explains guest-cost effects from user data only', () => {
  const base = event();
  const past = analyzeImpact(base, [{ op: 'update_event', field: 'date', value: '2020-01-01' }], { now: new Date('2026-11-01T10:00:00Z') });
  assert.equal(past.blockers.length, 1);
  assert.match(past.blockers[0], /in the past/);

  const overspend = analyzeImpact(base, [{ op: 'update_event', field: 'budget', value: 10000 }], { now: new Date() });
  assert.ok(overspend.blockers.some(message => /already spent/.test(message)), JSON.stringify(overspend.blockers));

  const guests = analyzeImpact(base, [{ op: 'update_event', field: 'guests', value: 300 }], { now: new Date() });
  assert.equal(guests.blockers.length, 0);
  assert.ok(guests.warnings.some(warning => /catering/.test(warning)), JSON.stringify(guests.warnings));
  assert.match(guests.warnings.join(' '), /derived from your own recorded amounts/);

  const foreign = analyzeImpact(base, [{ op: 'update_task', taskId: 'someone-elses-task', status: 'completed' }], { now: new Date() });
  assert.equal(foreign.blockers.length, 1);
});

test('per-guest catering uses recorded expenses, then allocation, then nothing', () => {
  const base = event();
  assert.equal(perGuestCatering({ ...base, expenses: [], categories: [{ id: 'cat-food', name: 'Catering', allocation: 320000 }] }), 1280);
  assert.equal(perGuestCatering({ ...base, categories: [{ id: 'cat-food', name: 'Photography', allocation: 100000 }], expenses: [] }), null);
  assert.equal(perGuestCatering({ ...base, guests: 0, guestsCount: 0 }), null);
});

test('fingerprint binds a proposal to the exact event fields', () => {
  const base = event();
  assert.equal(eventFingerprint(base), eventFingerprint({ ...base }));
  assert.notEqual(eventFingerprint(base), eventFingerprint({ ...base, budget: 799999 }));
  assert.notEqual(eventFingerprint(base), eventFingerprint({ ...base, name: 'Renamed' }));
});

test('accepted AI task deadlines respect the event date and never land in the past', () => {
  const base = { ...event(), date: '2026-11-05' };
  const applied = applyActions(base, [
    { op: 'add_tasks', tasks: [{ title: 'Urgent booking', relativeDeadlineDays: 90, priority: 'high' }] }
  ], { now: new Date('2026-11-01T10:00:00Z') });
  const task = applied.results.find(result => result.op === 'add_tasks');
  assert.ok(task.ok);
  const added = base.tasks.find(task2 => task2.title === 'Urgent booking');
  assert.equal(added.dueDate, '2026-11-01', 'clamped to today rather than a past date');
  assert.equal(added.urgency, 'schedule-now');
});
