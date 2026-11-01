/**
 * Structured-output validators. Every model reply passes through here before it
 * can be stored or displayed, so a hallucinated field shape stops at the
 * boundary instead of reaching the event record.
 */
import { indiaDateToday } from './core.mjs';
import { isoDate } from './planning.mjs';

const LIMITS = { assumptions: 12, missingInformation: 12, tasks: 24, ideas: 12, vendorRequirements: 12, risks: 12, categories: 12 };
const text = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const listOf = (value, max, mapper, field) => {
  if (!Array.isArray(value) || value.length > max) throw new Error(`AI field ${field} is invalid.`);
  return value.map(mapper);
};
const EVENT_TYPES = ['wedding', 'birthday', 'community'];

const DEFAULT_STRATEGY = event => ({
  overview: `${event.type} for about ${Number(event.guests) || 0} guests in ${event.city}.`,
  concept: 'No concept was returned, so start from your own brief and refine it with the assistant.',
  theme: text(event.profile?.style?.[0], 80) || 'Theme not set',
  priorities: ['Lock the date and venue', 'Agree the budget split', 'Book the long-lead vendors'],
  challenges: ['Requirements are still partly unspecified.'],
  recommendations: ['Use the assistant to revise any part of this plan as your details change.']
});

function normalizeVendorRequirement(item) {
  if (!item || typeof item !== 'object') throw new Error('Invalid AI vendor requirement.');
  const category = text(item.category, 80);
  if (category.length < 2) throw new Error('AI vendor requirement needs a category.');
  const days = item.whenBeforeEventDays;
  if (!(days === null || days === undefined || (typeof days === 'number' && Number.isInteger(days) && days >= 0 && days <= 365))) {
    throw new Error('AI vendor requirement has an invalid booking lead time.');
  }
  const priority = ['low', 'medium', 'high'].includes(item.priority) ? item.priority : 'medium';
  const criteria = Array.isArray(item.selectionCriteria) || item.selectionCriteria === undefined
    ? (item.selectionCriteria || []).slice(0, 8).map(value => text(value, 200)).filter(Boolean)
    : (() => { throw new Error('AI vendor selection criteria must be a list.'); })();
  return { category, why: text(item.why, 300), whenBeforeEventDays: days ?? null, priority, selectionCriteria: criteria };
}

/**
 * Validates a plan proposal. Accepts both the current schema (strategy +
 * vendorRequirements) and the earlier Trial 15 shape (vendorChecklist only), so
 * stored proposals from the previous build still load.
 */
export function validateAIProposal(value, event) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI response must be a JSON object.');
  const assumptions = listOf(value.assumptions || [], LIMITS.assumptions, item => text(item, 300), 'assumptions').filter(Boolean);
  const missingInformation = listOf(value.missingInformation || [], LIMITS.missingInformation, item => text(item, 200), 'missingInformation').filter(Boolean);

  const strategy = value.strategy === undefined ? DEFAULT_STRATEGY(event) : (() => {
    const item = value.strategy;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('AI strategy must be an object.');
    const overview = text(item.overview, 400); const concept = text(item.concept, 400); const theme = text(item.theme, 120);
    if (!overview || !concept) throw new Error('AI strategy needs an overview and a concept.');
    return {
      overview, concept, theme: theme || 'Theme not set',
      priorities: (item.priorities || []).slice(0, 8).map(entry => text(entry, 200)).filter(Boolean),
      challenges: (item.challenges || []).slice(0, 8).map(entry => text(entry, 200)).filter(Boolean),
      recommendations: (item.recommendations || []).slice(0, 8).map(entry => text(entry, 300)).filter(Boolean)
    };
  })();

  const budgetCategories = listOf(value.budgetCategories, LIMITS.categories, item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid AI budget category.');
    const name = text(item.name, 60); const sharePercent = item.sharePercent;
    if (name.length < 2 || typeof sharePercent !== 'number' || !Number.isFinite(sharePercent) || sharePercent < 0 || sharePercent > 100) {
      throw new Error('Invalid AI budget allocation.');
    }
    return { name, sharePercent: Math.round(sharePercent * 100) / 100, rationale: text(item.rationale, 240) };
  }, 'budgetCategories');
  if (!budgetCategories.length) throw new Error('AI proposal must include budget categories.');
  const names = budgetCategories.map(category => category.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('AI budget category names must be unique.');
  const totalShare = budgetCategories.reduce((sum, category) => sum + category.sharePercent, 0);
  if (Math.abs(totalShare - 100) > 0.01) throw new Error('AI budget category percentages must total 100%.');

  const tasks = listOf(value.tasks, LIMITS.tasks, item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid AI task.');
    const title = text(item.title, 120); const relativeDeadlineDays = item.relativeDeadlineDays;
    if (title.length < 2 || !(relativeDeadlineDays === null || relativeDeadlineDays === undefined
      || (typeof relativeDeadlineDays === 'number' && Number.isInteger(relativeDeadlineDays) && relativeDeadlineDays >= 0 && relativeDeadlineDays <= 365))) {
      throw new Error('Invalid AI task deadline or title.');
    }
    if (!['low', 'medium', 'high'].includes(item.priority)) throw new Error('Invalid AI task priority.');
    return {
      title, description: text(item.description, 300), relativeDeadlineDays: relativeDeadlineDays ?? null,
      priority: item.priority, rationale: text(item.rationale, 240), dependsOnTitle: text(item.dependsOnTitle, 120) || null
    };
  }, 'tasks');
  const taskTitles = tasks.map(task => task.title.toLowerCase());
  if (new Set(taskTitles).size !== taskTitles.length) throw new Error('AI task titles must be unique.');
  for (const task of tasks) {
    if (task.dependsOnTitle && !taskTitles.includes(task.dependsOnTitle.toLowerCase())) throw new Error('AI task depends on an unknown task.');
    if (task.dependsOnTitle && task.dependsOnTitle.toLowerCase() === task.title.toLowerCase()) throw new Error('AI task cannot depend on itself.');
  }
  if (!tasks.length || !value.ideas?.length) throw new Error('AI proposal must include tasks and ideas.');

  const ideas = listOf(value.ideas, LIMITS.ideas, item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid AI idea.');
    const title = text(item.title, 100); const description = text(item.description, 400);
    if (!title || !description) throw new Error('AI idea requires a title and description.');
    return { title, description, personalizationReason: text(item.personalizationReason, 240) };
  }, 'ideas');

  const vendorRequirements = value.vendorRequirements !== undefined
    ? listOf(value.vendorRequirements, LIMITS.vendorRequirements, normalizeVendorRequirement, 'vendorRequirements')
    : listOf(value.vendorChecklist || [], LIMITS.vendorRequirements, item => ({
      category: text(item?.category, 80), why: '', whenBeforeEventDays: null, priority: 'medium',
      selectionCriteria: Array.isArray(item?.whatToVerify) ? item.whatToVerify.slice(0, 8).map(entry => text(entry, 200)).filter(Boolean) : []
    }), 'vendorChecklist').filter(item => item.category);
  const requirementNames = vendorRequirements.map(item => item.category.toLowerCase());
  if (new Set(requirementNames).size !== requirementNames.length) throw new Error('AI vendor requirement categories must be unique.');

  const risks = listOf(value.risks || [], LIMITS.risks, item => ({ risk: text(item?.risk, 240), mitigation: text(item?.mitigation, 300) }), 'risks')
    .filter(item => item.risk && item.mitigation);

  return {
    assumptions, missingInformation, strategy, budgetCategories, tasks, ideas, vendorRequirements, risks,
    vendorChecklist: vendorRequirements.map(item => ({ category: item.category, whatToVerify: item.selectionCriteria })),
    event: {
      type: event.type, name: event.name, city: event.city, date: event.date || null,
      guestCount: event.guests, budgetPaise: Math.round(event.budget * 100), currency: 'INR'
    }
  };
}

/** Natural-language intake: never trusts the model's numbers or dates. */
export function validateExtraction(value, brief = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI response must be a JSON object.');
  const list = key => Array.isArray(value[key]) ? value[key].slice(0, 10).map(item => text(item, 160)).filter(Boolean) : [];
  const type = EVENT_TYPES.includes(value.eventType) ? value.eventType : null;
  const budget = Number(value.budgetINR);
  const guests = Number(value.guestCount);
  const date = isoDate(String(value.date ?? ''));
  const questions = Array.isArray(value.followUpQuestions) ? value.followUpQuestions.slice(0, 4).map(item => ({
    question: text(item?.question, 200), whyItMatters: text(item?.whyItMatters, 200)
  })).filter(item => item.question) : [];
  if (!questions.length && Array.isArray(value.followUpQuestions) && value.followUpQuestions.length) {
    throw new Error('AI follow-up questions need question text.');
  }
  const fields = {
    name: text(value.eventName, 100) || text(brief, 60).slice(0, 60) || 'New event',
    type,
    city: text(value.city, 80),
    date,
    guests: Number.isInteger(guests) && guests >= 0 && guests <= 100_000 ? guests : null,
    budget: Number.isFinite(budget) && budget >= 0 && budget <= 1_000_000_000 ? Math.round(budget * 100) / 100 : null
  };
  return {
    fields,
    profile: {
      style: list('stylePreferences'), culture: list('culturalNotes'), dietary: list('dietary'),
      accessibility: list('accessibility'), priorities: list('priorities'), constraints: list('constraints')
    },
    assumptions: list('assumptions'),
    missingInformation: list('missingInformation'),
    followUpQuestions: questions,
    summary: text(value.summary, 400),
    // Judged on the validated fields, never on whatever the model returned.
    unconfirmed: [
      !fields.type && 'event type', !fields.date && 'event date', fields.guests === null && 'guest count',
      fields.budget === null && 'budget', !fields.city && 'city'
    ].filter(Boolean)
  };
}

/**
 * Pre-event conversation turn. The model returns the WHOLE current picture, so
 * anything it drops or garbles falls back to what the user already told us —
 * one bad turn must never erase the details gathered in an earlier one.
 */
export function validateConsult(value, known = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI response must be a JSON object.');
  const reply = text(value.reply, 700);
  if (reply.length < 2) throw new Error('AI reply is empty.');
  if (Array.isArray(value.questions) && value.questions.length > 2) throw new Error('Too many questions returned.');
  const questions = Array.isArray(value.questions) ? value.questions.map(item => text(item, 240)).filter(Boolean) : [];
  const raw = value.fields && typeof value.fields === 'object' ? value.fields : {};
  const today = indiaDateToday();
  const date = isoDate(String(raw.date ?? ''));
  const type = EVENT_TYPES.includes(raw.eventType) ? raw.eventType : (EVENT_TYPES.includes(known.type) ? known.type : null);
  const guests = Number(raw.guestCount);
  const budget = Number(raw.budgetINR);
  const list = key => Array.isArray(raw[key]) ? raw[key].slice(0, 6).map(item => text(item, 160)).filter(Boolean) : (Array.isArray(known[key]) ? known[key] : []);
  const resolvedType = type || null;
  const resolvedCity = text(raw.city, 80) || known.city || '';
  // A name is not something the model gets to invent. If the user never gave
  // one, the interface names it from what is actually known.
  const fallbackName = resolvedType ? `${resolvedType[0].toUpperCase()}${resolvedType.slice(1)}${resolvedCity ? ` in ${resolvedCity}` : ''}` : 'New event';
  return {
    reply,
    questions,
    fields: {
      name: text(raw.eventName, 100) || known.name || fallbackName,
      type: resolvedType,
      city: resolvedCity,
      date: date && date >= today ? date : (known.date && known.date >= today ? known.date : null),
      guests: Number.isInteger(guests) && guests > 0 && guests <= 100_000 ? guests : (known.guests ?? null),
      budget: Number.isFinite(budget) && budget > 0 && budget <= 1_000_000_000 ? Math.round(budget * 100) / 100 : (known.budget ?? null),
      style: list('style'),
      priorities: list('priorities')
    }
  };
}

const KNOWN_OPS = new Set(['update_event', 'set_budget_allocation', 'add_budget_category', 'add_tasks', 'update_task', 'remove_task', 'add_vendor_requirement', 'update_vendor_status', 'set_profile', 'add_ideas']);
/** Assistant turns: bounded prose plus a proposal list that is only ever
 * screened by deterministic code before anything is applied. */
export function validateAssistantTurn(value, event) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI response must be a JSON object.');
  const reply = text(value.reply, 1400);
  if (!reply) throw new Error('AI assistant reply was empty.');
  const actions = Array.isArray(value.actions) ? value.actions.slice(0, 12) : [];
  if (!Array.isArray(value.actions)) throw new Error('AI assistant actions must be a list.');
  for (const action of actions) {
    if (!action || typeof action !== 'object' || !KNOWN_OPS.has(action.op)) throw new Error(`AI proposed an unsupported action "${String(action?.op).slice(0, 40)}".`);
  }
  return {
    reply,
    impactSummary: text(value.impactSummary, 600),
    affectedComponents: (Array.isArray(value.affectedComponents) ? value.affectedComponents : []).slice(0, 10).map(item => text(item, 80)).filter(Boolean),
    questions: (Array.isArray(value.questions) ? value.questions : []).slice(0, 3).map(item => text(item, 240)).filter(Boolean),
    actions,
    eventId: event?.id || null,
    generatedAt: new Date().toISOString(),
    today: indiaDateToday()
  };
}
