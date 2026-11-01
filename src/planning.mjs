/**
 * Deterministic planning core: everything that must be *correct* rather than
 * plausible. Money, dates, dependency order, fingerprinting and the guarded
 * application of AI-proposed actions. No model call happens in this file.
 */
import { randomUUID } from 'node:crypto';
import { indiaDateToday, validateEvent } from './core.mjs';

export const PAISE = value => Math.round(Number(value) * 100);
export const RUPEE = paise => paise / 100;

/**
 * The planned head-count. A persisted event stores `guests` as the guest LIST
 * and `guestsCount` as the number, while a freshly validated plan stores the
 * number in `guests` — reading either one blindly silently produces 0.
 */
export function plannedGuests(event) {
  const count = Number(event?.guestsCount);
  if (Number.isFinite(count) && count >= 0) return count;
  if (Array.isArray(event?.guests)) return 0;
  const legacy = Number(event?.guests);
  return Number.isFinite(legacy) && legacy >= 0 ? legacy : 0;
}

export function guestList(event) {
  return Array.isArray(event?.guests) ? event.guests : [];
}

export function eventFingerprint(event) {
  return JSON.stringify({
    name: event.name, type: event.type, city: event.city, date: event.date,
    budget: event.budget, guests: plannedGuests(event)
  });
}

export function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

export function shiftDate(date, daysBefore) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day - daysBefore)).toISOString().slice(0, 10);
}

/**
 * Converts percentage shares to paise. Largest-remainder keeps the total exact
 * without dumping the residue on one unlucky line (a share of 33.33% must not
 * silently become the whole remainder).
 */
export function sharesToPaise(totalPaise, shares) {
  if (!shares.length) return [];
  const raw = shares.map(share => (Number(totalPaise) * Number(share)) / 100);
  const floors = raw.map(value => Math.floor(value));
  let residue = Math.round(Number(totalPaise) - floors.reduce((a, b) => a + b, 0));
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const result = [...floors];
  for (let step = 0; residue > 0 && order.length; step = (step + 1) % order.length) {
    result[order[step].index] += 1;
    residue -= 1;
  }
  return result;
}

/**
 * Clamp overdue dates to today, then repair dependency order where that clamping
 * would invert it. A task that can no longer precede its dependent is reported
 * rather than quietly reordered, because the plan is the user's to decide on.
 */
export function resolveSchedule(tasks, eventDate, today = indiaDateToday()) {
  const warnings = [];
  const scheduled = tasks.map(task => {
    if (!eventDate || task.relativeDeadlineDays === null || task.relativeDeadlineDays === undefined) {
      return { ...task, dueDate: task.dueDate ?? null, urgency: 'undated' };
    }
    const ideal = shiftDate(eventDate, task.relativeDeadlineDays);
    const overdue = ideal < today;
    return { ...task, dueDate: overdue ? today : ideal, urgency: overdue ? 'schedule-now' : 'normal' };
  });
  for (const task of scheduled) {
    const dependency = task.dependsOnTitle
      ? scheduled.find(other => other.title.toLowerCase() === String(task.dependsOnTitle).toLowerCase())
      : null;
    if (!dependency) continue;
    if (!dependency.dueDate || !task.dueDate) continue;
    if (dependency.dueDate >= task.dueDate) {
      if (dependency.dueDate === today && task.dueDate === today) {
        warnings.push(`"${dependency.title}" and "${task.title}" both clamp to ${today}; finish ${dependency.title} first.`);
        task.urgency = 'schedule-now';
      } else if (dependency.dueDate < task.dueDate) {
        task.dueDate = shiftDate(task.dueDate, 1) < today ? today : shiftDate(task.dueDate, 1);
        warnings.push(`"${task.title}" moved to ${task.dueDate} so it still follows "${dependency.title}".`);
      } else {
        warnings.push(`"${dependency.title}" cannot be scheduled before "${task.title}"; review both dates.`);
      }
    }
  }
  return { tasks: scheduled, warnings };
}

/** Categories that already have recorded spend cannot be allocated below it. */
export function categorySpend(event, categoryId) {
  return (event.expenses || [])
    .filter(expense => expense.categoryId === categoryId)
    .reduce((sum, expense) => sum + PAISE(expense.amount), 0);
}

export function budgetView(event) {
  const allocated = (event.categories || []).reduce((sum, category) => sum + PAISE(category.allocation), 0);
  const spent = (event.expenses || []).reduce((sum, expense) => sum + PAISE(expense.amount), 0);
  const total = PAISE(event.budget);
  return {
    totalPaise: total,
    allocatedPaise: allocated,
    spentPaise: spent,
    unallocatedPaise: total - allocated,
    remainingPaise: total - spent,
    overAllocated: allocated > total,
    overSpent: spent > total,
    utilisationPercent: total ? Math.round((spent / total) * 1000) / 10 : 0
  };
}

/**
 * Deterministic consequence analysis for a proposed change set. Answers the
 * "what is affected and what breaks" questions without asking a model to do
 * arithmetic. Used both to warn the user before approval and to reject ops that
 * would corrupt state.
 */
export function analyzeImpact(event, actions, { now = new Date() } = {}) {
  const today = indiaDateToday(now);
  const effects = { affected: new Set(), warnings: [], blockers: [] };
  const next = structuredClone({ budget: event.budget, guests: plannedGuests(event), date: event.date || '', categories: event.categories || [], tasks: event.tasks || [], expenses: event.expenses || [] });
  for (const action of actions) {
    switch (action.op) {
      case 'update_event': {
        effects.affected.add(action.field);
        if (action.field === 'budget') {
          const change = PAISE(action.value) - PAISE(next.budget);
          next.budget = action.value;
          effects.affected.add('budget');
          if (change < 0) {
            const view = budgetView({ ...next, categories: next.categories });
            if (PAISE(action.value) < view.allocatedPaise) {
              const shortfall = RUPEE(view.allocatedPaise - PAISE(action.value));
              effects.warnings.push(`A cut of ${shortfall.toFixed(2)} INR leaves planned allocations above the new total; category lines must be reduced or the remainder left unallocated.`);
            }
            if (PAISE(action.value) < view.spentPaise) effects.blockers.push(`The new budget is below ${RUPEE(view.spentPaise).toFixed(2)} INR already spent; record or move those expenses first.`);
          }
        }
        if (action.field === 'guests') {
          const delta = Number(action.value) - Number(next.guests);
          next.guests = Number(action.value);
          effects.affected.add('catering');
          effects.affected.add('venue capacity');
          if (delta > 0) {
            const perGuest = perGuestCatering(event);
            if (perGuest !== null) effects.warnings.push(`${delta} more guests adds roughly ${(delta * perGuest).toFixed(0)} INR of catering at the current per-guest estimate, which is derived from your own recorded amounts, not a market price.`);
          }
        }
        if (action.field === 'date') {
          if (!isoDate(action.value)) effects.blockers.push(`${action.value} is not a real calendar date.`);
          else {
            const parsed = new Date(`${action.value}T12:00:00Z`);
            const reference = new Date(`${today}T12:00:00Z`);
            if (parsed < reference) effects.blockers.push(`${action.value} is in the past; choose a date from ${today} onward.`);
            next.date = action.value;
            const replanned = (next.tasks || []).filter(task => task.dueDate && task.status !== 'completed');
            if (replanned.length) effects.affected.add(`timeline (${replanned.length} open tasks need rescheduling)`);
            const catering = (next.categories || []).find(category => /catering|food/i.test(category.name));
            if (catering && Number(action.value) > 0) effects.affected.add('catering');
          }
          effects.affected.add('timeline');
        }
        if (action.field === 'city') effects.affected.add('vendors');
        break;
      }
      case 'set_budget_allocation': {
        effects.affected.add('budget');
        const category = (event.categories || []).find(item => item.id === action.categoryId);
        if (!category) effects.blockers.push(`Budget category ${action.categoryId} does not exist on this event.`);
        else {
          const spend = categorySpend(event, category.id);
          if (PAISE(action.allocationINR) < spend) effects.blockers.push(`"${category.name}" already has ${RUPEE(spend).toFixed(2)} INR recorded; raise the recorded expenses or the allocation, not both.`);
        }
        break;
      }
      case 'add_budget_category':
      case 'add_tasks':
      case 'add_ideas':
      case 'add_vendor_requirement':
        effects.affected.add(action.op === 'add_vendor_requirement' ? 'vendors' : action.op.replace('add_', ''));
        break;
      case 'update_task':
        effects.affected.add('timeline');
        if (action.taskId && !(event.tasks || []).some(task => task.id === action.taskId)) effects.blockers.push(`Task ${action.taskId} does not exist on this event.`);
        break;
      case 'remove_task':
        effects.affected.add('timeline');
        if (!(event.tasks || []).some(task => task.id === action.taskId)) effects.blockers.push(`Task ${action.taskId} does not exist on this event.`);
        break;
      case 'update_vendor_status':
        effects.affected.add('vendors');
        if (!(event.vendors || []).some(vendor => vendor.id === action.vendorId)) effects.blockers.push(`Vendor ${action.vendorId} does not exist on this event.`);
        break;
      case 'set_profile':
        effects.affected.add('personalisation');
        break;
      default:
        effects.blockers.push(`Unsupported action "${action.op}".`);
    }
  }
  const after = budgetView({ ...event, budget: next.budget, categories: next.categories });
  if (after.overAllocated && !actions.some(action => action.op === 'update_event' && action.field === 'budget')) {
    effects.warnings.push(`Planned allocations exceed the event budget by ${RUPEE(after.allocatedPaise - after.totalPaise).toFixed(2)} INR.`);
  }
  return { affected: [...effects.affected], warnings: effects.warnings, blockers: effects.blockers };
}

/** Per-guest catering cost derived only from data the user actually entered. */
export function perGuestCatering(event) {
  const guests = plannedGuests(event);
  if (!guests) return null;
  const catering = (event.categories || []).find(category => /catering|food/i.test(category.name));
  const fromExpenses = (event.expenses || [])
    .filter(expense => catering && expense.categoryId === catering.id)
    .reduce((sum, expense) => sum + PAISE(expense.amount), 0);
  const basis = fromExpenses ? RUPEE(fromExpenses) : catering ? Number(catering.allocation) : null;
  return basis === null ? null : basis / guests;
}

const OPS = new Set(['update_event', 'set_budget_allocation', 'add_budget_category', 'add_tasks', 'update_task', 'remove_task', 'add_vendor_requirement', 'update_vendor_status', 'set_profile', 'add_ideas']);

/**
 * Validates one proposed operation against the persisted event and returns the
 * mutation to perform, or an error string. Every op is checked against real ids
 * so a model cannot invent or address another event's records.
 */
export function normalizeAction(action, event, { now = new Date() } = {}) {
  if (!action || typeof action !== 'object') return { error: 'Action must be an object.' };
  if (!OPS.has(action.op)) return { error: `Unsupported action "${String(action.op).slice(0, 40)}".` };
  const money = value => { const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000 ? Math.round(n * 100) / 100 : null; };
  const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  switch (action.op) {
    case 'update_event': {
      const field = ['budget', 'guests', 'date', 'city', 'name'].includes(action.field) ? action.field : null;
      if (!field) return { error: 'update_event needs field budget, guests, date, city or name.' };
      if (field === 'budget') { const value = money(action.value); return value === null ? { error: 'Budget must be a non-negative INR amount.' } : { ...action, value }; }
      if (field === 'guests') { const value = Number(action.value); return Number.isInteger(value) && value >= 0 && value <= 100_000 ? { ...action, value } : { error: 'Guest count must be a whole number from 0 to 100,000.' }; }
      if (field === 'date') { const value = isoDate(String(action.value ?? '')); return value ? { ...action, value } : { error: 'Event date must be a real YYYY-MM-DD date.' }; }
      const value = text(action.value, field === 'name' ? 100 : 80);
      return value.length >= 2 ? { ...action, value } : { error: `${field} needs at least 2 characters.` };
    }
    case 'set_budget_allocation': {
      const category = (event.categories || []).find(item => item.id === String(action.categoryId));
      if (!category) return { error: 'That budget category is not part of this event.' };
      const value = money(action.allocationINR);
      if (value === null) return { error: 'Allocation must be a non-negative INR amount.' };
      const spend = RUPEE(categorySpend(event, category.id));
      if (value < spend) return { error: `"${category.name}" has ${spend.toFixed(2)} INR recorded; allocation cannot be lower.` };
      return { ...action, categoryId: category.id, allocationINR: value, categoryName: category.name };
    }
    case 'add_budget_category': {
      const name = text(action.name, 60);
      if (name.length < 2) return { error: 'Category name needs 2–60 characters.' };
      if ((event.categories || []).some(item => item.name.toLowerCase() === name.toLowerCase())) return { error: `Category "${name}" already exists.` };
      const value = money(action.allocationINR ?? 0);
      return { ...action, name, allocationINR: value };
    }
    case 'add_tasks': {
      if (!Array.isArray(action.tasks) || !action.tasks.length || action.tasks.length > 24) return { error: 'add_tasks needs 1–24 tasks.' };
      const existing = new Set((event.tasks || []).map(task => task.title.toLowerCase()));
      const tasks = [];
      for (const item of action.tasks) {
        const title = text(item?.title, 160);
        if (title.length < 2) return { error: 'Every task needs a title of 2–160 characters.' };
        if (existing.has(title.toLowerCase())) continue;
        const relative = item?.relativeDeadlineDays;
        if (!(relative === null || relative === undefined || (Number.isInteger(relative) && relative >= 0 && relative <= 365))) return { error: `Task "${title}" has an invalid deadline offset.` };
        const priority = ['low', 'medium', 'high'].includes(item?.priority) ? item.priority : 'medium';
        const dependency = text(item?.dependsOnTitle, 160);
        existing.add(title.toLowerCase());
        tasks.push({ title, description: text(item?.description, 300), relativeDeadlineDays: relative ?? null, priority, dependsOnTitle: dependency || null, rationale: text(item?.rationale, 240) });
      }
      return tasks.length ? { ...action, tasks } : { error: 'Those tasks already exist on this event.' };
    }
    case 'update_task': {
      const task = (event.tasks || []).find(item => item.id === String(action.taskId));
      if (!task) return { error: 'That task is not part of this event.' };
      const patch = {};
      if (action.status && ['pending', 'in_progress', 'completed'].includes(action.status)) patch.status = action.status;
      if (action.title !== undefined) { const title = text(action.title, 160); if (title.length < 2) return { error: 'Task title needs 2–160 characters.' }; patch.title = title; }
      if (action.dueDate !== undefined) { const due = isoDate(String(action.dueDate)); if (!due) return { error: 'Task due date must be a real YYYY-MM-DD date.' }; patch.dueDate = due; }
      if (action.relativeDeadlineDays !== undefined) {
        const relative = action.relativeDeadlineDays;
        if (!(relative === null || (Number.isInteger(relative) && relative >= 0 && relative <= 365))) return { error: 'Deadline offset must be 0–365 days before the event.' };
        if (!event.date) return { error: 'This event has no date, so a relative deadline cannot be resolved. Give the task an explicit due date instead.' };
        const candidate = shiftDate(event.date, relative);
        patch.dueDate = candidate < indiaDateToday(now) ? indiaDateToday(now) : candidate;
        patch.relativeDeadlineDays = relative;
        patch.urgency = candidate < indiaDateToday(now) ? 'schedule-now' : 'normal';
      }
      if (!Object.keys(patch).length) return { error: 'update_task needs a status, title or date to change.' };
      return { ...action, taskId: task.id, patch, taskTitle: task.title };
    }
    case 'remove_task': {
      const task = (event.tasks || []).find(item => item.id === String(action.taskId));
      return task ? { ...action, taskId: task.id, taskTitle: task.title } : { error: 'That task is not part of this event.' };
    }
    case 'add_vendor_requirement': {
      const category = text(action.category, 80);
      if (category.length < 2) return { error: 'Vendor category is required.' };
      if ((event.vendorRequirements || []).some(item => item.category.toLowerCase() === category.toLowerCase())) return { error: `A requirement for "${category}" already exists.` };
      const days = action.whenBeforeEventDays;
      if (!(days === null || days === undefined || (Number.isInteger(days) && days >= 0 && days <= 365))) return { error: 'Booking lead time must be 0–365 days before the event.' };
      return {
        ...action, category,
        why: text(action.why, 300),
        whenBeforeEventDays: days ?? null,
        selectionCriteria: Array.isArray(action.selectionCriteria) ? action.selectionCriteria.slice(0, 8).map(item => text(item, 200)).filter(Boolean) : [],
        priority: ['low', 'medium', 'high'].includes(action.priority) ? action.priority : 'medium'
      };
    }
    case 'update_vendor_status': {
      const vendor = (event.vendors || []).find(item => item.id === String(action.vendorId));
      if (!vendor) return { error: 'That vendor is not part of this event.' };
      const status = ['enquiring', 'quoted', 'booked', 'cancelled'].includes(action.status) ? action.status : null;
      return status ? { ...action, vendorId: vendor.id, vendorName: vendor.name, status } : { error: 'Vendor status must be enquiring, quoted, booked or cancelled.' };
    }
    case 'set_profile': {
      const field = ['culture', 'dietary', 'accessibility', 'priorities', 'constraints', 'style'].includes(action.field) ? action.field : null;
      if (!field) return { error: 'set_profile needs a known profile field.' };
      const value = Array.isArray(action.value) ? action.value.map(item => text(item, 160)).filter(Boolean).slice(0, 12) : text(action.value, 300);
      if (!value || (Array.isArray(value) && !value.length)) return { error: 'set_profile needs a value.' };
      return { ...action, field, value };
    }
    case 'add_ideas': {
      if (!Array.isArray(action.ideas) || !action.ideas.length || action.ideas.length > 12) return { error: 'add_ideas needs 1–12 ideas.' };
      const ideas = action.ideas.map(item => ({ title: text(item?.title, 100), description: text(item?.description, 400), personalizationReason: text(item?.personalizationReason, 240) })).filter(item => item.title && item.description);
      return ideas.length ? { ...action, ideas } : { error: 'Each idea needs a title and a description.' };
    }
    default: return { error: 'Unsupported action.' };
  }
}

/**
 * Applies validated operations one at a time. Unaffected records are never
 * rewritten, and a failing op does not stop the rest — the user sees exactly
 * which part of an AI suggestion landed and which did not.
 */
export function applyActions(event, actions, { now = new Date() } = {}) {
  const results = [];
  const changed = new Set();
  for (const raw of actions) {
    const action = normalizeAction(raw, event, { now });
    if (action.error) { results.push({ op: raw?.op || 'unknown', ok: false, error: action.error }); continue; }
    try {
      switch (action.op) {
        case 'update_event': {
          if (action.field === 'date') {
            event.date = action.value;
            const open = (event.tasks || []).filter(task => task.dueDate && task.status !== 'completed' && task.source !== 'user');
            const { tasks, warnings } = resolveSchedule(open.map(task => ({ ...task, relativeDeadlineDays: daysBetween(action.value, task.dueDate) })), action.value, indiaDateToday(now));
            for (const task of tasks) {
              const target = (event.tasks || []).find(item => item.title === task.title && item.dueDate);
              if (target) { target.dueDate = task.dueDate; target.urgency = task.urgency; }
            }
            results.push({ op: action.op, ok: true, detail: `Event date set to ${action.value}; ${tasks.length} open tasks re-evaluated.`, warnings });
          } else if (action.field === 'guests') {
            event.guestsCount = action.value;
            results.push({ op: action.op, ok: true, detail: `Planned guest count set to ${action.value}. Your guest list is untouched.` });
            changed.add('event');
          } else {
            event[action.field] = action.value;
            results.push({ op: action.op, ok: true, detail: `${action.field} set to ${action.value}.` });
            changed.add('event');
          }
          changed.add('event');
          break;
        }
        case 'set_budget_allocation': {
          const category = event.categories.find(item => item.id === action.categoryId);
          category.allocation = action.allocationINR;
          category.source = 'ai-accepted';
          results.push({ op: action.op, ok: true, detail: `${category.name} allocation set to ${action.allocationINR.toFixed(2)} INR.` });
          changed.add('budget');
          break;
        }
        case 'add_budget_category': {
          const category = { id: randomUUID(), name: action.name, allocation: action.allocationINR, source: 'ai-accepted', rationale: action.rationale ? String(action.rationale).slice(0, 240) : '' };
          event.categories.push(category);
          results.push({ op: action.op, ok: true, detail: `Added category ${category.name}.` });
          changed.add('budget');
          break;
        }
        case 'add_tasks': {
          const { tasks, warnings } = resolveSchedule(action.tasks, event.date, indiaDateToday(now));
          for (const task of tasks) {
            event.tasks.push({ id: randomUUID(), title: task.title, description: task.description, dueDate: task.dueDate, urgency: task.urgency, priority: task.priority, status: 'pending', source: 'ai-accepted', rationale: task.rationale, dependsOnTitle: task.dependsOnTitle });
          }
          results.push({ op: action.op, ok: true, detail: `Added ${tasks.length} task(s).`, warnings });
          changed.add('timeline');
          break;
        }
        case 'update_task': {
          const task = event.tasks.find(item => item.id === action.taskId);
          Object.assign(task, action.patch);
          results.push({ op: action.op, ok: true, detail: `Updated "${task.title}".` });
          changed.add('timeline');
          break;
        }
        case 'remove_task': {
          event.tasks = event.tasks.filter(item => item.id !== action.taskId);
          results.push({ op: action.op, ok: true, detail: `Removed "${action.taskTitle}".` });
          changed.add('timeline');
          break;
        }
        case 'add_vendor_requirement': {
          event.vendorRequirements = event.vendorRequirements || [];
          event.vendorRequirements.push({ id: randomUUID(), ...action, source: 'ai-accepted', createdAt: now.toISOString() });
          results.push({ op: action.op, ok: true, detail: `Added vendor requirement: ${action.category}.` });
          changed.add('vendors');
          break;
        }
        case 'update_vendor_status': {
          const vendor = event.vendors.find(item => item.id === action.vendorId);
          vendor.status = action.status;
          vendor.source = 'user-entered';
          results.push({ op: action.op, ok: true, detail: `${vendor.name} marked ${action.status}.` });
          changed.add('vendors');
          break;
        }
        case 'set_profile': {
          event.profile = { ...(event.profile || {}), [action.field]: action.value };
          results.push({ op: action.op, ok: true, detail: `Profile ${action.field} updated.` });
          changed.add('profile');
          break;
        }
        case 'add_ideas': {
          event.ideaItems = [...(event.ideaItems || []), ...action.ideas.map(idea => ({ ...idea, source: 'ai-accepted' }))];
          event.aiProposedIdeas = [...(event.aiProposedIdeas || []), ...action.ideas];
          results.push({ op: action.op, ok: true, detail: `Added ${action.ideas.length} idea(s).` });
          changed.add('ideas');
          break;
        }
        default: results.push({ op: action.op, ok: false, error: 'Unsupported action.' });
      }
    } catch (error) {
      results.push({ op: action.op, ok: false, error: error.message || 'Could not apply this change.' });
    }
  }
  event.updatedAt = now.toISOString();
  return { results, changed: [...changed] };
}

export function daysBetween(eventDate, dueDate) {
  const a = Date.parse(`${eventDate}T12:00:00Z`);
  const b = Date.parse(`${dueDate}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((a - b) / 86_400_000));
}

/** Re-validated so a persisted event that drifted is caught before prompting. */
export function eventForPrompt(event) {
  const summary = budgetView(event);
  return {
    name: event.name,
    type: event.type,
    city: event.city,
    date: event.date || null,
    guests: plannedGuests(event),
    budgetINR: Number(event.budget),
    currency: 'INR',
    profile: event.profile || {},
    calculated: {
      allocatedINR: RUPEE(summary.allocatedPaise),
      spentINR: RUPEE(summary.spentPaise),
      unallocatedINR: RUPEE(summary.unallocatedPaise),
      remainingINR: RUPEE(summary.remainingPaise),
      overBudget: summary.overSpent
    },
    budgetCategories: (event.categories || []).map(c => ({ id: c.id, name: c.name, allocationINR: Number(c.allocation), spentINR: RUPEE(categorySpend(event, c.id)) })),
    openTasks: (event.tasks || []).filter(t => t.status !== 'completed').slice(0, 40).map(t => ({ id: t.id, title: t.title, dueDate: t.dueDate, priority: t.priority })),
    completedTaskCount: (event.tasks || []).filter(t => t.status === 'completed').length,
    vendorRequirements: (event.vendorRequirements || []).map(v => ({ id: v.id, category: v.category })),
    vendors: (event.vendors || []).map(v => ({ id: v.id, category: v.category, status: v.status })),
    guestCount: {
      invited: guestList(event).length,
      accepted: guestList(event).filter(guest => guest.rsvp === 'accepted').length,
      declined: guestList(event).filter(guest => guest.rsvp === 'declined').length
    },
    quotations: (event.quotations || []).map(q => ({ id: q.id, vendorId: q.vendorId, amountINR: Number(q.amount) }))
  };
}
