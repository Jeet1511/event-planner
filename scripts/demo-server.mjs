/**
 * OFFLINE DEMO SERVER — not a model.
 *
 *   node scripts/demo-server.mjs        → http://127.0.0.1:3311
 *
 * Runs the real application with a scripted provider so the whole AI workflow
 * (brief → structured plan → review → save → assistant → approve) can be
 * clicked through with no key, no download and no network. Every response is
 * canned, so the UI labels it "Test AI". This file is a development harness:
 * it contains no planning intelligence, only fixed JSON for each request shape.
 */
import { createApp } from '../server.mjs';

const PLAN = {
  assumptions: ['Single-day wedding with an evening reception.', 'Catering is expected to be the largest line.'],
  missingInformation: ['Ritual schedule and guest arrival time are not specified.'],
  strategy: {
    overview: 'A 250-guest traditional Bengali wedding in Kolkata on 1 February 2027 with an INR 8,00,000 budget.',
    concept: 'Courtyard ceremony with warm layering, a live regional menu and one unhurried gathering space.',
    theme: 'Marigold and terracotta',
    priorities: ['Confirm the venue before styling', 'Lock catering volume against the guest count', 'Protect photography lead time'],
    challenges: ['Peak-season demand for February dates', 'Two large lines (venue and catering) absorb 70% of the budget'],
    recommendations: ['Book venue and catering first, then spend the remainder on styling', 'Keep the contingency untouched until quotations arrive']
  },
  budgetCategories: [
    { name: 'Venue', sharePercent: 28, rationale: 'Hall plus ceremony area for 250' },
    { name: 'Catering', sharePercent: 38, rationale: 'Largest per-guest cost' },
    { name: 'Decoration', sharePercent: 16, rationale: 'Theme and lighting' },
    { name: 'Photography', sharePercent: 10, rationale: 'Two-day coverage window' },
    { name: 'Logistics', sharePercent: 4, rationale: 'Guest seating and transport' },
    { name: 'Contingency', sharePercent: 4, rationale: 'Unplanned costs' }
  ],
  tasks: [
    { title: 'Confirm event date and requirements', description: 'Fix the date and the functions on it.', relativeDeadlineDays: 120, priority: 'high', rationale: 'Every other lead time hangs off this.', dependsOnTitle: '' },
    { title: 'Shortlist and inspect venues', description: 'Visit two halls, check capacity and access.', relativeDeadlineDays: 100, priority: 'high', rationale: 'Venue locks the rest of the plan.', dependsOnTitle: 'Confirm event date and requirements' },
    { title: 'Book the chosen venue', description: 'Sign and pay the deposit.', relativeDeadlineDays: 90, priority: 'high', rationale: 'February dates go early.', dependsOnTitle: 'Shortlist and inspect venues' },
    { title: 'Collect catering tastings and quotations', description: 'Three per-plate options for 250 guests.', relativeDeadlineDays: 75, priority: 'high', rationale: 'Volume pricing needs lead time.', dependsOnTitle: 'Book the chosen venue' },
    { title: 'Finalise decoration concept', description: 'Agree theme, lighting and stage scope.', relativeDeadlineDays: 45, priority: 'medium', rationale: 'Needs the confirmed floor plan.', dependsOnTitle: 'Book the chosen venue' },
    { title: 'Finalise guest list', description: 'Confirm head count for catering and seating.', relativeDeadlineDays: 30, priority: 'medium', rationale: 'Catering quantity depends on it.', dependsOnTitle: 'Collect catering tastings and quotations' },
    { title: 'Reconfirm all vendors', description: 'Confirm timings, contacts and balances.', relativeDeadlineDays: 3, priority: 'high', rationale: 'Last checkpoint before the day.', dependsOnTitle: '' }
  ],
  ideas: [
    { title: 'Terracotta and marigold layering', description: 'Reuse the same palette across the entrance, stage and tables instead of three separate decor sets.', personalizationReason: 'Traditional Bengali palette keeps cost per square foot down.' },
    { title: 'One live cooking counter', description: 'A single regional live station instead of several, which reads as hospitality without multiplying staff.', personalizationReason: 'Good catering was named as a priority.' },
    { title: 'Seating that keeps families together', description: 'Group by relationship rather than by age so elders and children sit together.', personalizationReason: 'A memorable experience was named as a priority.' },
    { title: 'Candle-lit courtyard fallback', description: 'If the outdoor slot is lost to weather, the same lighting works indoors without re-buying decor.', personalizationReason: 'Protects the theme at no extra cost.' }
  ],
  vendorRequirements: [
    { category: 'Venue', why: 'Decoration, catering volume and guest flow all depend on the confirmed floor plan.', whenBeforeEventDays: 90, priority: 'high', selectionCriteria: ['Confirmed capacity for 250', 'Written cancellation terms', 'Access and parking checked in person'] },
    { category: 'Catering', why: 'Quantity scales directly with the guest count, so per-plate pricing must be fixed early.', whenBeforeEventDays: 75, priority: 'high', selectionCriteria: ['Per-plate quotation in writing', 'Tasting before deposit', 'Clear staff-to-guest ratio'] },
    { category: 'Photography', why: 'Fixed wedding dates are scarce; the shoot cannot be added later at the same quality.', whenBeforeEventDays: 60, priority: 'medium', selectionCriteria: ['Portfolio of comparable events', 'Delivery timeline in the agreement', 'Second shooter cost stated'] },
    { category: 'Decoration', why: 'Styling is the most compressible line, so scope it after the venue is known.', whenBeforeEventDays: 45, priority: 'medium', selectionCriteria: ['Itemised decor quotation', 'Setup and teardown times', 'What is reused across functions'] },
    { category: 'Guest logistics', why: 'Seating, transport and accessibility need the final head count.', whenBeforeEventDays: 21, priority: 'medium', selectionCriteria: ['Step-free route confirmed', 'Seating plan before the day', 'Transport slots for elders'] }
  ],
  risks: [
    { risk: 'February dates sell out before quotations arrive', mitigation: 'Hold the venue with a refundable deposit before finalising styling.' },
    { risk: 'Guest count moves after catering is fixed', mitigation: 'Agree a per-plate rate and a final count deadline two to three weeks out.' },
    { risk: 'Two lines absorb 66% of the budget', mitigation: 'Take catering and venue quotations first, then spend what is genuinely left.' },
    { risk: 'Outdoor functions are weather-dependent', mitigation: 'Choose a venue with an indoor space that fits the same guest count.' }
  ]
};

const EXTRACTION = {
  eventName: 'Ananya & Arjun wedding', eventType: 'wedding', city: 'Kolkata', date: '2027-02-01',
  guestCount: 250, budgetINR: 800000,
  stylePreferences: ['elegant decoration'], culturalNotes: ['traditional Bengali'],
  dietary: [], accessibility: [], priorities: ['good catering', 'memorable experience'], constraints: [],
  assumptions: ['The ₹8 lakh figure is the total, including any contingency.'],
  missingInformation: ['How many days of functions are planned.'],
  followUpQuestions: [
    { question: 'Is this a single-day wedding or multiple functions?', whyItMatters: 'Venue days and catering volumes are the two biggest cost drivers.' },
    { question: 'Roughly what share of the 250 guests will attend each function?', whyItMatters: 'Catering and seating are priced per head per function.' }
  ],
  summary: 'A 250-guest traditional Bengali wedding in Kolkata on 1 February 2027 with an INR 8,00,000 budget, weighted toward catering and elegant decoration.'
};

const TURNS = [
  {
    reply: 'Two of your lines can absorb this cut without touching the guest experience. Venue and catering hold 66% of the plan, so the honest options are a smaller decoration scope and dropping the contingency line to a true buffer. I have not invented any prices: the numbers below are the same allocations your app already holds, resized.',
    impactSummary: 'A 25% budget cut, carried mainly by decoration and photography.',
    affectedComponents: ['budget', 'vendors'],
    questions: ['Do you want to keep the same guest count?'],
    actions: [
      { op: 'update_event', field: 'budget', value: '600000' },
      { op: 'add_tasks', tasks: [{ title: 'Renegotiate the decoration scope', description: 'Ask for the same palette with fewer sets instead of a new theme.', relativeDeadlineDays: 40, priority: 'high', rationale: 'Most compressible line.', dependsOnTitle: '' }] },
      { op: 'add_vendor_requirement', category: 'Catering (second quotation)', why: 'A second per-plate quotation gives you real leverage on the largest line.', whenBeforeEventDays: 60, priority: 'high', selectionCriteria: ['Same menu, different vendor', 'Per-plate rate in writing'] }
    ]
  },
  {
    reply: 'Fifty more guests is a catering and seating problem before it is a money problem. Your recorded catering allocation is what your app already has, so the additional cost below is derived from that figure — it is not a market quote. I propose adding a reconfirm-head-count task and a second catering requirement rather than rewriting the whole plan.',
    impactSummary: 'Guest count rises 20%; catering volume and seating follow.',
    affectedComponents: ['catering', 'guests', 'timeline'],
    questions: [],
    actions: [
      { op: 'update_event', field: 'guests', value: 300 },
      { op: 'add_tasks', tasks: [{ title: 'Reconfirm head count with caterer', description: 'Confirm the final number and the deadline to change it.', relativeDeadlineDays: 21, priority: 'high', rationale: 'Catering quantity depends on it.', dependsOnTitle: '' }] }
    ]
  },
  {
    reply: 'A cancellation this far from the date is recoverable, but it is now the urgent item. I have marked nothing as booked, because only you can confirm who is available. Check the photography requirement for the criteria to compare against, and treat the deposit terms in your own notes as the first thing to read.',
    impactSummary: 'Photography becomes the critical path; other lines are unaffected.',
    affectedComponents: ['vendors', 'timeline'],
    questions: ['Was the photographer already paid a deposit?'],
    actions: [
      { op: 'add_tasks', tasks: [{ title: 'Shortlist replacement photographers', description: 'Three options, portfolio of comparable events, rates in writing.', relativeDeadlineDays: 45, priority: 'high', rationale: 'Fixed-date demand means this cannot wait.', dependsOnTitle: '' }] },
      { op: 'add_vendor_requirement', category: 'Photography (replacement)', why: 'The original booking is gone and the date is fixed.', whenBeforeEventDays: 45, priority: 'high', selectionCriteria: ['Available on your date, confirmed in writing', 'Deposit and refund terms', 'Delivery timeline stated'] }
    ]
  }
];

const GENERIC_TURN = {
  reply: 'This is the offline demo provider, so it answers with fixed text instead of reasoning about your event. Start the real server with a Gemini key or a local Ollama model and this reply will reflect your actual plan.',
  impactSummary: 'No changes proposed.', affectedComponents: [], questions: [], actions: []
};

let turnIndex = 0;
const scripted = {
  plan: PLAN,
  intake: EXTRACTION,
  // Keyword routing keeps the demo reproducible: the same question always gets the
  // same proposal, instead of a rotating script that drifts out of sync with the chat.
  assistant: prompt => {
    // Route on the user message alone: the prompt also carries the entire event
    // state, whose vendor categories ("Photography") would match these keywords.
    const quoted = /latestUserMessage[\\"':]+([^"\\]+)/.exec(String(prompt || ''));
    const text = quoted ? quoted[1] : String(prompt || '');
    if (/cancel|photograph|no longer available/i.test(text)) return TURNS[2];
    if (/guest|head count|invite more|more people/i.test(text)) return TURNS[1];
    if (/budget|lakh|crore|cut|reduce|cheap|elegant/i.test(text)) return TURNS[0];
    turnIndex += 1;
    return GENERIC_TURN;
  }
};

const demoProvider = {
  id: 'mock',
  label: 'Offline demo (scripted)',
  model: 'eventpilot-demo-script',
  configured: true,
  async health() {
    return { status: 'local_model_ready', provider: 'mock', model: 'eventpilot-demo-script', detail: 'Scripted demo responses. Not a model: every reply here is fixed text from scripts/demo-server.mjs.' };
  },
  async generate(request) {
    const schemaName = request.schemaName || 'plan';
    const value = typeof scripted[schemaName] === 'function' ? scripted[schemaName](request.prompt) : scripted[schemaName] || GENERIC_TURN;
    return { content: JSON.stringify(value), model: 'eventpilot-demo-script', provider: 'mock', usage: {} };
  }
};

const app = createApp({
  dataDir: process.env.EVENTPILOT_DATA_DIR || new URL('../.demo-data/', import.meta.url).pathname.replace(/^\//, ''),
  ai: { provider: demoProvider }
});
const address = await app.listen(Number(process.env.PORT || 3311), '127.0.0.1');
console.log(`EventPilot OFFLINE DEMO (scripted AI, not a model): http://127.0.0.1:${address.port}`);
