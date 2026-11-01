export const EVENT_TYPES = ['wedding', 'birthday', 'community'];

export function indiaDateToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(now);
  const part = key => parts.find(item => item.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export const DEFAULT_CATEGORIES = [
  ['Venue', 0.17], ['Catering', 0.34], ['Decoration', 0.13],
  ['Photography', 0.09], ['Clothing & makeup', 0.08],
  ['Entertainment', 0.05], ['Logistics', 0.05], ['Contingency', 0.09]
];

export function validateEvent(input) {
  if (!input || typeof input !== 'object') throw new Error('Event details are required.');
  const name = String(input.name ?? '').trim();
  const city = String(input.city ?? '').trim();
  const type = String(input.type ?? 'wedding');
  const budget = Number(input.budget);
  const guests = Number(input.guests);
  if (name.length < 2 || name.length > 100) throw new Error('Event name must contain 2–100 characters.');
  if (city.length < 2 || city.length > 80) throw new Error('City must contain 2–80 characters.');
  if (!EVENT_TYPES.includes(type)) throw new Error('Choose a supported event type.');
  if (!Number.isFinite(budget) || budget < 0 || budget > 1_000_000_000) throw new Error('Enter a valid budget in INR.');
  if (!Number.isInteger(guests) || guests < 0 || guests > 100_000) throw new Error('Guest count must be a whole number from 0 to 100,000.');
  const date = input.date ? String(input.date) : '';
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) !== date)) throw new Error('Date must be a real calendar date in YYYY-MM-DD format.');
  return { name, city, type, budget: Math.round(budget * 100) / 100, guests, date, currency: 'INR' };
}

export function allocateBudget(total, categories = DEFAULT_CATEGORIES) {
  const amount = Number(total);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Budget must be a non-negative number.');
  const paise = Math.round(amount * 100);
  let assigned = 0;
  return categories.map(([name, ratio], index) => {
    const allocation = index === categories.length - 1
      ? paise - assigned
      : Math.round(paise * ratio);
    assigned += allocation;
    return { name, allocation: allocation / 100 };
  });
}

export function calculateBudget(event) {
  const categories = event.categories ?? [];
  const expenses = event.expenses ?? [];
  const totalAllocated = categories.reduce((sum, c) => sum + Math.round(Number(c.allocation) * 100), 0);
  const totalSpent = expenses.reduce((sum, e) => sum + Math.round(Number(e.amount) * 100), 0);
  return {
    total: Number(event.budget),
    allocated: totalAllocated / 100,
    spent: totalSpent / 100,
    remaining: (Math.round(Number(event.budget) * 100) - totalSpent) / 100,
    unallocated: (Math.round(Number(event.budget) * 100) - totalAllocated) / 100
  };
}

export function createPlan(input) {
  const event = validateEvent(input);
  const categories = allocateBudget(event.budget);
  const now = new Date();
  const due = (daysBefore) => {
    if (!event.date) return { date:null, urgency:'undated' };
    const [year, month, day] = event.date.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day - daysBefore));
    const candidate = d.toISOString().slice(0, 10);
    const today = indiaDateToday(now);
    return candidate < today ? { date:today, urgency:'schedule-now' } : { date:candidate, urgency:'normal' };
  };
  const common = [
    ['Confirm event date and requirements', 120, 'high'],
    ['Shortlist and inspect venues', 90, 'high'],
    ['Collect vendor quotations', 75, 'high'],
    ['Confirm catering and menu', 45, 'high'],
    ['Finalize guest list', 30, 'medium'],
    ['Confirm logistics and schedule', 14, 'medium'],
    ['Reconfirm vendors and arrangements', 3, 'high']
  ];
  const typeTasks = {
    wedding: [['Plan ceremony and rituals', 60, 'high'], ['Arrange clothing and makeup', 45, 'medium'], ['Coordinate photography requirements', 30, 'medium']],
    birthday: [['Choose party theme and activities', 30, 'medium'], ['Arrange cake and entertainment', 14, 'medium'], ['Prepare party favours', 7, 'low']],
    community: [['Confirm permissions and venue rules', 90, 'high'], ['Assign volunteer responsibilities', 30, 'high'], ['Prepare accessibility and safety plan', 21, 'high']]
  };
  const tasks = [...common, ...typeTasks[event.type]].map(([title, days, priority]) => {
    const schedule = due(days);
    return { id:crypto.randomUUID(), title, dueDate:schedule.date, urgency:schedule.urgency, priority, status:'pending', source:'template' };
  });
  const ideas = {
    wedding: ['Create a ceremony schedule that accounts for travel between venues.', 'Consider a locally inspired menu and clearly label dietary options.', 'Keep a weather contingency for outdoor functions.'],
    birthday: ['Choose one clear theme and repeat it across invitations, cake and decor.', 'Plan an activity suitable for the youngest and oldest guests.', 'Keep a small contingency for last-minute supplies.'],
    community: ['Assign a named volunteer to each operational area.', 'Plan crowd flow, accessible routes and emergency contacts.', 'Publish a clear run-of-show for speakers and performers.']
  };
  return { event, categories, tasks, ideas: ideas[event.type], generatedAt: now.toISOString(), mode: 'rules-fallback' };
}

export function validateExpense(input, event) {
  const description = String(input.description ?? '').trim();
  const amount = Number(input.amount);
  const categoryId = String(input.categoryId ?? '');
  if (description.length < 2 || description.length > 160) throw new Error('Expense description must contain 2–160 characters.');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) throw new Error('Expense amount must be greater than zero.');
  if (!event.categories.some(c => c.id === categoryId)) throw new Error('Select a category belonging to this event.');
  const date = input.date || indiaDateToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) !== date) throw new Error('Expense date must be a real YYYY-MM-DD date.');
  return { id: crypto.randomUUID(), description, amount: Math.round(amount * 100) / 100, categoryId, date, idempotencyKey: String(input.idempotencyKey || '') };
}
