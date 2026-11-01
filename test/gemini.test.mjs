import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGeminiProvider, toGeminiSchema, AIProviderError } from '../src/ai-providers.mjs';
import { generatePlan, understandBrief, cleanError } from '../src/ai.mjs';
import { Schemas } from '../src/ai.mjs';

const event = { type: 'wedding', name: 'Ananya & Arjun', city: 'Kolkata', date: '2027-02-01', guests: 250, budget: 800000 };
const proposal = {
  assumptions: [], missingInformation: [],
  strategy: { overview: 'A 250-guest Kolkata wedding.', concept: 'Courtyard ceremony.', theme: 'Marigold', priorities: ['Venue'], challenges: ['Rain'], recommendations: ['Book early'] },
  budgetCategories: [{ name: 'Venue', sharePercent: 60, rationale: 'Space' }, { name: 'Food', sharePercent: 40, rationale: 'Meals' }],
  tasks: [{ title: 'Confirm venue', description: 'Sign agreement', relativeDeadlineDays: 90, priority: 'high', rationale: 'Lead time', dependsOnTitle: '' }],
  ideas: [{ title: 'Terracotta', description: 'Local craft runners.', personalizationReason: 'Traditional' }],
  vendorRequirements: [{ category: 'Catering', why: 'Feeds guests', whenBeforeEventDays: 45, priority: 'high', selectionCriteria: ['Per-plate quote'] }],
  risks: [{ risk: 'Rain', mitigation: 'Covered backup' }]
};

/** A stand-in for generativelanguage.googleapis.com so the adapter itself is
 * verified (auth header, schema shape, parsing, error mapping) with no key. */
async function withFakeGemini(handler, run) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    await handler(req, res, raw, seen.length - 1);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1beta`;
  try { return await run(baseUrl, seen); } finally { await new Promise(resolve => server.close(resolve)); }
}

const jsonReply = payload => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 700 } });

test('Gemini health reports a ready model without putting the key in the URL', async () => {
  await withFakeGemini((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }] }));
  }, async (baseUrl, seen) => {
    const provider = createGeminiProvider({ apiKey: 'AIza-fake-key-for-tests', model: 'gemini-2.5-flash', baseUrl });
    const health = await provider.health();
    assert.equal(health.status, 'remote_model_ready');
    assert.equal(health.provider, 'gemini');
    assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-fake-key-for-tests');
    assert.ok(!seen[0].url.includes('AIza'), 'the key never appears in the request path');
  });
});

test('Gemini health distinguishes a rejected key from a missing model', async () => {
  await withFakeGemini((_req, res) => { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad key' } })); }, async baseUrl => {
    const health = await createGeminiProvider({ apiKey: 'AIza-fake', model: 'gemini-2.5-flash', baseUrl }).health();
    assert.equal(health.status, 'runtime_unavailable');
    assert.match(health.detail, /rejected the API key/);
  });
  const unconfigured = await createGeminiProvider({ apiKey: '', model: 'x', baseUrl: 'http://127.0.0.1:1/v1beta' }).health();
  assert.equal(unconfigured.status, 'no_credentials');
});

test('structured plan generation sends a Gemini-shaped schema and validates the reply', async () => {
  await withFakeGemini((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(jsonReply(proposal))); }, async (baseUrl, seen) => {
    const provider = createGeminiProvider({ apiKey: 'AIza-fake', model: 'gemini-2.5-flash', baseUrl });
    const result = await generatePlan(event, { provider });
    const request = seen[0];
    assert.equal(request.method, 'POST');
    assert.match(request.url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(request.body.generationConfig.responseSchema.type, 'OBJECT');
    assert.equal(request.body.generationConfig.responseSchema.properties.budgetCategories.items.type, 'OBJECT');
    assert.equal(request.body.generationConfig.responseSchema.properties.tasks.items.properties.priority.enum.join(','), 'low,medium,high');
    assert.equal(request.body.generationConfig.responseSchema.properties.budgetCategories.items.additionalProperties, undefined, 'unsupported keywords are stripped');
    assert.ok(request.body.systemInstruction.parts[0].text.includes('untrusted DATA'));
    assert.ok(request.body.contents[0].parts[0].text.includes('<event_data>'));
    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, 'gemini-2.5-flash', 'falls back to the configured model name when the reply omits modelVersion');
    assert.equal(result.proposal.budgetCategories.length, 2);
    assert.equal(result.proposal.strategy.theme, 'Marigold');
    assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 700 });
  });
});

test('a fenced or padded reply is recovered, a non-reply is refused after one retry', async () => {
  const fenced = {
    candidates: [{
      content: { parts: [{ text: '```json\n' + JSON.stringify(proposal) + '\n```' }] },
      finishReason: 'STOP'
    }]
  };
  const prose = {
    candidates: [{ content: { parts: [{ text: 'Sorry, I cannot help with that.' }] }, finishReason: 'STOP' }]
  };
  await withFakeGemini((_req, res, _raw, index) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(index === 0 ? fenced : prose));
  }, async (baseUrl, seen) => {
    const provider = createGeminiProvider({ apiKey: 'AIza-fake', model: 'gemini-2.5-flash', baseUrl });
    const result = await generatePlan(event, { provider });
    assert.equal(result.proposal.tasks[0].title, 'Confirm venue');
    assert.equal(seen.length, 1, 'a fenced reply parses on the first pass');

    const strict = createGeminiProvider({ apiKey: 'AIza-fake', model: 'gemini-2.5-flash', baseUrl });
    await assert.rejects(() => understandBrief('A small gathering next month.', { provider: strict }), error => {
      assert.equal(error.name, 'AIResponseError');
      assert.equal(seen.length, 3, 'prose triggers exactly one recovery attempt then stops');
      return true;
    });
  });
});

test('provider HTTP failures map to clean codes and never leak the endpoint', async () => {
  await withFakeGemini((_req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'quota' } })); }, async baseUrl => {
    const provider = createGeminiProvider({ apiKey: 'AIza-fake', model: 'gemini-2.5-flash', baseUrl });
    const error = await generatePlan(event, { provider }).then(() => null, caught => caught);
    assert.ok(error instanceof AIProviderError);
    assert.equal(error.code, 'rate_limited');
    const cleaned = cleanError(error);
    assert.equal(cleaned.status, 'rate_limited');
    assert.ok(!cleaned.detail.includes('127.0.0.1'), `endpoint must be redacted: ${cleaned.detail}`);
  });
  await withFakeGemini((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] })); }, async baseUrl => {
    const error = await generatePlan(event, { provider: createGeminiProvider({ apiKey: 'AIza-fake', baseUrl }) })
      .catch(caught => caught);
    // An empty/truncated candidate is an empty response, retried once, then surfaced.
    assert.equal(error.name, 'AIResponseError');
    assert.match(error.message, /recovery attempt/);
  });
});

test('safety blocks and prompt blocks are reported as refusals', async () => {
  await withFakeGemini((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }));
  }, async baseUrl => {
    const error = await generatePlan(event, { provider: createGeminiProvider({ apiKey: 'AIza-fake', baseUrl }) }).catch(caught => caught);
    assert.equal(error.code, 'blocked');
  });
});

test('toGeminiSchema converts nullable types and drops JSON-Schema-only keywords', () => {
  const converted = toGeminiSchema(Schemas.plan.properties.tasks.items.properties.relativeDeadlineDays);
  assert.equal(converted.type, 'INTEGER');
  const enumOnly = toGeminiSchema(Schemas.plan.properties.tasks.items.properties.priority);
  assert.equal(enumOnly.type, 'STRING');
  assert.deepEqual(enumOnly.enum, ['low', 'medium', 'high']);
});

test('a custom Gemini host needs an explicit opt-in before any request leaves the machine', async () => {
  const previousBase = process.env.GEMINI_BASE_URL;
  const previousCustom = process.env.GEMINI_ALLOW_CUSTOM_BASE_URL;
  process.env.GEMINI_BASE_URL = 'https://attacker.example/v1beta';
  delete process.env.GEMINI_ALLOW_CUSTOM_BASE_URL;
  try {
    const provider = createGeminiProvider({ apiKey: 'AIza-fake' });
    const health = await provider.health();
    assert.equal(health.status, 'runtime_unavailable');
    assert.match(health.detail, /generativelanguage\.googleapis\.com unless GEMINI_ALLOW_CUSTOM_BASE_URL=true/);
    await assert.rejects(() => provider.generate({ schema: {}, system: 's', prompt: 'p' }), /GEMINI_ALLOW_CUSTOM_BASE_URL/);
  } finally {
    if (previousBase === undefined) delete process.env.GEMINI_BASE_URL; else process.env.GEMINI_BASE_URL = previousBase;
    if (previousCustom === undefined) delete process.env.GEMINI_ALLOW_CUSTOM_BASE_URL; else process.env.GEMINI_ALLOW_CUSTOM_BASE_URL = previousCustom;
  }
});

test('link-local metadata addresses are refused even as Ollama endpoints', async () => {
  const previous = process.env.OLLAMA_ALLOW_REMOTE;
  process.env.OLLAMA_ALLOW_REMOTE = 'true';
  try {
    const { resolveOllamaBaseUrl } = await import('../src/ai-providers.mjs');
    assert.throws(() => resolveOllamaBaseUrl('http://169.254.169.254'), /link-local metadata/);
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_ALLOW_REMOTE; else process.env.OLLAMA_ALLOW_REMOTE = previous;
  }
});

test('the real Google host stays allowed without any opt-in flag', async () => {
  const provider = createGeminiProvider({ apiKey: '' });
  const health = await provider.health();
  assert.equal(health.status, 'no_credentials', 'an unconfigured key fails before any network call');
});
