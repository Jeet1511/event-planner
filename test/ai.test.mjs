import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAIProposal } from '../src/ai.mjs';

const event = { type:'birthday', name:'A birthday', city:'Kolkata', date:'2027-02-01', guests:80, budget:100000 };
const valid = {
  assumptions:[], missingInformation:[],
  budgetCategories:[{name:'Venue',sharePercent:60,rationale:'Space'},{name:'Food',sharePercent:40,rationale:'Meals'}],
  tasks:[{title:'Confirm venue',description:'Compare options',relativeDeadlineDays:14,priority:'high',rationale:'Lead time'}],
  ideas:[{title:'Theme',description:'Use a consistent theme',personalizationReason:'Birthday'}],
  vendorChecklist:[{category:'Catering',whatToVerify:['Menu','Tax']}],
  risks:[{risk:'Rain',mitigation:'Indoor backup'}]
};

test('AI proposal validates and normalizes bounded structured fields', () => {
  const result = validateAIProposal(valid, event);
  assert.equal(result.event.budgetPaise, 10000000);
  assert.equal(result.tasks[0].relativeDeadlineDays, 14);
  assert.equal(result.ideas.length, 1);
});

test('AI proposal rejects invalid budget percentages', () => {
  const bad = structuredClone(valid); bad.budgetCategories[0].sharePercent = 20;
  assert.throws(() => validateAIProposal(bad, event), /total 100/);
});

test('AI proposal rejects excessive and invalid deadlines', () => {
  const bad = structuredClone(valid); bad.tasks[0].relativeDeadlineDays = 999;
  assert.throws(() => validateAIProposal(bad, event), /deadline/);
});

test('AI proposal rejects empty task and idea collections', () => {
  const bad = structuredClone(valid); bad.tasks = [];
  assert.throws(() => validateAIProposal(bad, event), /tasks and ideas/);
});

test('AI budget percentages cannot over-allocate the event budget', () => {
  const bad = structuredClone(valid);
  bad.budgetCategories = [
    {name:'Venue',sharePercent:50.2,rationale:'Space'},
    {name:'Food',sharePercent:50.2,rationale:'Meals'},
    {name:'Other',sharePercent:0,rationale:'Other'}
  ];
  assert.throws(() => validateAIProposal(bad, event), /total 100/);
});

import http from 'node:http';
import { generateStructuredPlan, ollamaHealth } from '../src/ai.mjs';

async function withMockOllama(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { return await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('Ollama health distinguishes a ready model and a missing model', async () => {
  await withMockOllama((_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({models:[{name:'qwen2.5:3b'}]}));}, async baseUrl => {
    const ready = await ollamaHealth({baseUrl,model:'qwen2.5:3b'});
    const missing = await ollamaHealth({baseUrl,model:'llama3.2:3b'});
    assert.equal(ready.status,'local_model_ready');
    assert.equal(missing.status,'model_missing');
  });
});

test('Ollama structured plan adapter sends schema and validates the response', async () => {
  const responseBody = { model:'qwen2.5:3b', message:{content:JSON.stringify(valid)} };
  await withMockOllama(async (req,res)=>{
    assert.equal(req.url,'/api/chat');
    let raw=''; for await (const chunk of req) raw+=chunk;
    const request=JSON.parse(raw);
    assert.equal(request.stream,false);
    assert.equal(request.format.type,'object');
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(responseBody));
  }, async baseUrl => {
    const result=await generateStructuredPlan(event,{baseUrl,model:'qwen2.5:3b'});
    assert.equal(result.provider,'ollama');
    assert.equal(result.model,'qwen2.5:3b');
    assert.equal(result.proposal.tasks[0].title,'Confirm venue');
  });
});

test('remote Ollama endpoints are blocked unless explicitly opted into', async () => {
  const previous = process.env.OLLAMA_ALLOW_REMOTE;
  delete process.env.OLLAMA_ALLOW_REMOTE;
  try {
    const health = await ollamaHealth({baseUrl:'https://example.invalid',model:'qwen2.5:3b'});
    assert.equal(health.status,'runtime_unavailable');
    assert.match(health.detail,/Remote Ollama endpoints are blocked/);
    await assert.rejects(() => generateStructuredPlan(event,{baseUrl:'https://example.invalid'}), /Remote Ollama endpoints are blocked/);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_ALLOW_REMOTE;
    else process.env.OLLAMA_ALLOW_REMOTE = previous;
  }
});
