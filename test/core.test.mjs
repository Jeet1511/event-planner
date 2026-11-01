import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBudget, calculateBudget, createPlan, validateEvent, validateExpense, indiaDateToday } from '../src/core.mjs';

test('budget allocation sums exactly to total to the paisa', () => {
  for (const amount of [0, 1, 999.99, 1200000, 123456.78]) {
    const allocations = allocateBudget(amount);
    const sum = allocations.reduce((n, x) => n + Math.round(x.allocation * 100), 0);
    assert.equal(sum, Math.round(amount * 100));
  }
});

test('event validation rejects unsupported types and invalid guest counts', () => {
  assert.throws(() => validateEvent({name:'A wedding',city:'Kolkata',type:'concert',budget:100,guests:10}));
  assert.throws(() => validateEvent({name:'A wedding',city:'Kolkata',type:'wedding',budget:100,guests:-1}));
  assert.throws(() => validateEvent({name:'A wedding',city:'Kolkata',type:'wedding',budget:-1,guests:10}));
  assert.throws(() => validateEvent({name:'A wedding',city:'Kolkata',type:'wedding',budget:100,guests:10,date:'2027-02-31'}));
});

test('all three event types generate a structured plan', () => {
  for (const type of ['wedding','birthday','community']) {
    const plan = createPlan({name:'Test event',city:'Kolkata',type,budget:1200000,guests:300,date:'2027-02-01'});
    assert.equal(plan.event.type,type);
    assert.ok(plan.tasks.length >= 8);
    assert.ok(plan.ideas.length >= 3);
    assert.equal(plan.categories.reduce((n,c)=>n+Math.round(c.allocation*100),0),120000000);
  }
});

test('budget summary uses integer paise arithmetic', () => {
  const summary = calculateBudget({budget:1000,categories:[{allocation:1000}],expenses:[{amount:125.25},{amount:74.75}]});
  assert.equal(summary.spent,200);
  assert.equal(summary.remaining,800);
  assert.equal(summary.allocated,1000);
});

test('expense must reference a category belonging to its event', () => {
  const event = {categories:[{id:'cat-1'}]};
  assert.throws(() => validateExpense({description:'Venue advance',amount:100,categoryId:'other'},event));
  assert.equal(validateExpense({description:'Venue advance',amount:100,categoryId:'cat-1'},event).amount,100);
});

test('date-only task deadlines use calendar arithmetic independent of host timezone', () => {
  const plan = createPlan({name:'Date arithmetic',city:'Kolkata',type:'birthday',budget:1000,guests:20,date:'2027-04-01'});
  const venueTask = plan.tasks.find(t => t.title === 'Shortlist and inspect venues');
  assert.equal(venueTask.dueDate, '2027-01-01');
});


test('past ideal deadlines are clamped to today and marked schedule-now', () => {
  const [y,m,d] = indiaDateToday().split('-').map(Number);
  const eventDate = new Date(Date.UTC(y,m-1,d+7)).toISOString().slice(0,10);
  const plan = createPlan({name:'Short notice',city:'Kolkata',type:'birthday',budget:1000,guests:20,date:eventDate});
  const venueTask = plan.tasks.find(t => t.title === 'Shortlist and inspect venues');
  assert.equal(venueTask.dueDate, indiaDateToday());
  assert.equal(venueTask.urgency, 'schedule-now');
});
