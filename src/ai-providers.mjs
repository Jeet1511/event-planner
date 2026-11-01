/**
 * AI provider adapters. One small interface so the orchestration layer in ai.mjs
 * never knows which model answered:
 *
 *   provider = { id, label, model, health(), generate(request) -> {json, model, usage} }
 *
 * request = { schemaName, schema, system, prompt, maxOutputTokens, temperature, timeoutMs }
 *
 * Credentials stay server-side and are read from the environment only. Outbound
 * endpoints are constrained so a mis-set base URL cannot turn the app into a proxy.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const LINK_LOCAL_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata', 'fd00:ec2::254']);
const GEMINI_HOST_ALLOWLIST = new Set(['generativelanguage.googleapis.com']);

export class AIProviderError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    /** Provider-side explanation, kept out of user-facing copy. */
    this.detail = String(detail).slice(0, 300);
    /** Seconds the provider asked us to wait, when it told us. */
    this.retryAfterSeconds = null;
  }
}

function normalizeBaseUrl(raw, { label, allowRemote }) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new AIProviderError('bad_config', `${label} endpoint is not a valid URL.`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AIProviderError('bad_config', `${label} endpoint must use HTTP or HTTPS.`);
  if (LINK_LOCAL_HOSTS.has(parsed.hostname)) throw new AIProviderError('blocked_endpoint', `${label} endpoint points at a link-local metadata service and is refused.`);
  const isLocal = LOCAL_HOSTS.has(parsed.hostname);
  if (!isLocal && !allowRemote) throw new AIProviderError('blocked_endpoint', `${label} endpoint is remote; set the documented allow flag only if you intentionally trust that endpoint.`);
  return parsed.toString().replace(/\/$/, '');
}

/** Gemini-specific guard: a free-form base URL would be an SSRF vector. */
function geminiBaseUrl() {
  const raw = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const parsed = new URL(raw);
  if (!GEMINI_HOST_ALLOWLIST.has(parsed.hostname) && process.env.GEMINI_ALLOW_CUSTOM_BASE_URL !== 'true') {
    throw new AIProviderError('blocked_endpoint', 'GEMINI_BASE_URL must be generativelanguage.googleapis.com unless GEMINI_ALLOW_CUSTOM_BASE_URL=true.');
  }
  return normalizeBaseUrl(raw, { label: 'Gemini', allowRemote: true }).replace(/\/v1beta$/, '') + '/v1beta';
}

/**
 * Gemini's responseSchema accepts a JSON-Schema subset: upper-case types, no
 * additionalProperties. Converts once so every schema in this app stays written
 * as ordinary JSON Schema for Ollama and for the tests.
 */
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' || key === '$schema') continue;
    if (key === 'type') {
      const options = Array.isArray(value) ? value : [value];
      const simple = options.filter(t => t !== 'null');
      out.type = (simple[0] || 'string').toUpperCase();
    } else if (key === 'properties' || key === 'items') {
      out[key] = key === 'items' ? toGeminiSchema(value)
        : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toGeminiSchema(v)]));
    } else if (key === 'enum') {
      out.enum = value.filter(v => typeof v === 'string');
      out.type = 'STRING';
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'STRING' && !out.format) delete out.format;
  return out;
}

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

function geminiText(payload) {
  const candidate = payload?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return parts.map(part => part?.text || '').join('');
}

export function createGeminiProvider({
  apiKey = process.env.GEMINI_API_KEY || '',
  model = process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  baseUrl
} = {}) {
  const id = 'gemini';
  return {
    id,
    label: 'Google Gemini',
    model,
    configured: Boolean(apiKey),
    async health() {
      if (!apiKey) return { status: 'no_credentials', provider: id, model, detail: 'GEMINI_API_KEY is not set, so cloud generation is disabled.' };
      try {
        const endpoint = baseUrl || geminiBaseUrl();
        const response = await fetch(`${endpoint}/models?pageSize=200`, {
          headers: { 'x-goog-api-key': apiKey },
          signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) {
          const detail = response.status === 403 || response.status === 401 ? 'Gemini rejected the API key.' : `Gemini returned HTTP ${response.status}.`;
          return { status: 'runtime_unavailable', provider: id, model, detail };
        }
        const payload = await readJson(response);
        const found = (payload.models || []).some(item => String(item.name || '').split('/').pop() === model);
        return found
          ? { status: 'remote_model_ready', provider: id, model, detail: `Gemini ${model} is reachable.` }
          : { status: 'model_missing', provider: id, model, detail: `Gemini account did not list ${model}. Set GEMINI_MODEL to an available model.` };
      } catch (error) {
        return { status: 'runtime_unavailable', provider: id, model, detail: error.message || 'Gemini is not reachable.' };
      }
    },
    async generate({ schema, system, prompt, temperature = 0.2, maxOutputTokens = 4096, timeoutMs = 45000 } = {}) {
      if (!apiKey) throw new AIProviderError('no_credentials', 'Gemini API key is not configured.');
      const endpoint = (baseUrl || geminiBaseUrl()) + `/models/${encodeURIComponent(model)}:generateContent`;
      const body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          ...(schema ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) } : {})
        }
      };
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        if (error.name === 'TimeoutError') throw new AIProviderError('timeout', `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s.`);
        throw new AIProviderError('network', `Gemini request failed: ${error.message || 'network error'}.`);
      }
      const payload = await readJson(response);
      if (!response.ok) {
        const status = response.status;
        if (status === 429) throw new AIProviderError('rate_limited', 'Gemini free-tier quota reached (HTTP 429). Try again shortly or lower request volume.');
        if (status === 400) throw new AIProviderError('bad_request', `Gemini rejected the request (HTTP 400): ${String(payload?.error?.message || '').slice(0, 200)}`);
        throw new AIProviderError('provider_error', `Gemini returned HTTP ${status}.`);
      }
      if (payload?.promptFeedback?.blockReason) throw new AIProviderError('blocked', `Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
      const content = geminiText(payload);
      const finish = payload?.candidates?.[0]?.finishReason;
      if (!content.trim()) {
        const reason = finish === 'MAX_TOKENS' ? 'output truncated at the token limit' : finish ? finish.toLowerCase() : 'empty response';
        throw new AIProviderError('empty', `Gemini returned no usable content (${reason}).`);
      }
      if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') throw new AIProviderError('blocked', 'Gemini filtered the generated content.');
      return {
        content,
        model: payload?.modelVersion || model,
        provider: id,
        truncated: finish === 'MAX_TOKENS',
        usage: {
          inputTokens: payload?.usageMetadata?.promptTokenCount ?? null,
          outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? null
        }
      };
    }
  };
}

export function resolveOllamaBaseUrl(baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434') {
  const allowRemote = process.env.OLLAMA_ALLOW_REMOTE === 'true';
  let hostname;
  try { hostname = new URL(baseUrl).hostname; } catch { throw new AIProviderError('bad_config', 'Ollama endpoint is not a valid URL.'); }
  if (!allowRemote && !LOCAL_HOSTS.has(hostname)) {
    throw new AIProviderError('blocked_endpoint', 'Remote Ollama endpoints are blocked by default. Set OLLAMA_ALLOW_REMOTE=true only if you intentionally trust that endpoint.');
  }
  return normalizeBaseUrl(baseUrl, { label: 'Ollama', allowRemote: true });
}

/**
 * OpenAI-compatible chat-completions adapter, used for Groq by default. JSON mode
 * plus the application's own validator does the structuring; no provider-specific
 * schema dialect is needed. Any other compatible base URL works after an explicit
 * opt-in, because sending event data off this machine must be a deliberate choice.
 */
export function createOpenAICompatibleProvider({
  id = 'groq',
  label = 'Groq',
  apiKey = process.env.GROQ_API_KEY || '',
  model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  baseUrl,
  hostAllowlist = ['api.groq.com'],
  allowCustomFlag = 'GROQ_ALLOW_CUSTOM_BASE_URL'
} = {}) {
  const resolveBase = () => {
    const raw = baseUrl || process.env[`${id.toUpperCase()}_BASE_URL`] || (id === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1');
    let parsed;
    try { parsed = new URL(raw); } catch { throw new AIProviderError('bad_config', `${label} base URL is not valid.`); }
    const allowed = hostAllowlist.includes(parsed.hostname) || hostAllowlist.includes(parsed.host);
    if (!allowed && process.env[allowCustomFlag] !== 'true') {
      throw new AIProviderError('blocked_endpoint', `${label} base URL must be ${hostAllowlist.join(' or ')} unless ${allowCustomFlag}=true.`);
    }
    return normalizeBaseUrl(parsed.toString(), { label, allowRemote: true });
  };
  const headers = () => {
    if (!apiKey) throw new AIProviderError('no_credentials', `${label} API key is not configured.`);
    return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  };
  return {
    id,
    label,
    model,
    configured: Boolean(apiKey),
    async health() {
      if (!apiKey) return { status: 'no_credentials', provider: id, model, detail: `${id.toUpperCase()}_API_KEY is not set, so ${label} generation is disabled.` };
      try {
        const response = await fetch(`${resolveBase()}/models`, { headers: headers(), signal: AbortSignal.timeout(5000) });
        if (response.status === 401) return { status: 'runtime_unavailable', provider: id, model, detail: `${label} rejected the API key.` };
        if (!response.ok) return { status: 'runtime_unavailable', provider: id, model, detail: `${label} returned HTTP ${response.status}.` };
        const payload = await readJson(response);
        const list = Array.isArray(payload.data) ? payload.data : [];
        const found = list.some(item => item.id === model || String(item.id).startsWith(`${model}:`) || item.id?.startsWith(model));
        return found
          ? { status: 'remote_model_ready', provider: id, model, detail: `${label} ${model} is reachable.` }
          : { status: 'model_missing', provider: id, model, detail: `${label} account did not list ${model}. Set ${id.toUpperCase()}_MODEL to an available model.` };
      } catch (error) {
        if (error instanceof AIProviderError) return { status: 'runtime_unavailable', provider: id, model, detail: error.message };
        return { status: 'runtime_unavailable', provider: id, model, detail: error.message || `${label} is not reachable.` };
      }
    },
    async generate({ schemaName, schema, system, prompt, temperature = 0.2, maxOutputTokens = 3000, timeoutMs = 45000, reasoningEffort } = {}) {
      const started = Date.now();
      const body = {
        model,
        temperature,
        max_tokens: maxOutputTokens,
        response_format: schema || schemaName === 'plan' || schemaName === 'intake' || schemaName === 'assistant' ? { type: 'json_object' } : undefined,
        messages: [
          { role: 'system', content: `${system}\nRespond with a single JSON object only — no prose, no code fences, no commentary outside the JSON.` },
          { role: 'user', content: prompt }
        ]
      };
      // Reasoning models burn completion tokens (and TPM quota) thinking before
      // answering. These tasks are constrained JSON extraction, so low effort is
      // the measured-cheaper choice: 338 reasoning tokens became 6.
      const effort = reasoningEffort ?? (model.startsWith('openai/gpt-oss') ? 'low' : null);
      if (effort) body.reasoning_effort = effort;
      const response = await fetch(`${resolveBase()}/chat/completions`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      }).catch(error => {
        if (error.name === 'TimeoutError') throw new AIProviderError('timeout', `${label} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
        throw new AIProviderError('network', `${label} request failed: ${error.message || 'network error'}.`);
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const message = String(payload?.error?.message || '').slice(0, 200);
        if (response.status === 429) {
          // Groq sends no retry-after header but states the wait in the body, so
          // both are read: the UI can show a real countdown instead of a guess.
          const retry = Number(response.headers.get('retry-after'))
            || Number(String(message).match(/(?:retry|try again) in (\d+)\s*s/i)?.[1])
            || null;
          const error = new AIProviderError('rate_limited', `${label} is rate-limiting this key (HTTP 429)${retry ? `; retry in ${retry}s` : ''}. ${message}`, message);
          error.retryAfterSeconds = retry;
          throw error;
        }
        if (response.status === 401 || response.status === 403) throw new AIProviderError('no_credentials', `${label} refused the API key (HTTP ${response.status}).`);
        if (response.status === 400) {
          // Groq validates the JSON itself in json_object mode. When the model
          // hits max_tokens mid-object the provider answers 400 "Failed to
          // validate JSON" rather than returning a truncated body, so repeating
          // the same request can never succeed — the caller must raise the cap.
          if (/validat.*json|json.*validat|failed_generation/i.test(message)) {
            throw new AIProviderError('truncated', `${label} could not produce complete JSON within ${maxOutputTokens} output tokens.`, message);
          }
          throw new AIProviderError('bad_request', `${label} rejected the request (HTTP 400): ${message}`);
        }
        throw new AIProviderError('provider_error', `${label} returned HTTP ${response.status}.`);
      }
      const choice = payload?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const reason = choice?.finish_reason === 'length' ? 'output truncated at the token limit'
          : choice?.finish_reason === 'content_filter' ? 'content filtered by the provider'
          : (choice?.finish_reason || 'empty response');
        throw new AIProviderError('empty', `${label} returned no usable content (${reason}).`);
      }
      return {
        content,
        model: payload.model || model,
        provider: id,
        truncated: choice.finish_reason === 'length',
        usage: {
          inputTokens: payload?.usage?.prompt_tokens ?? null,
          outputTokens: payload?.usage?.completion_tokens ?? null,
          latencyMs: Date.now() - started
        }
      };
    }
  };
}

export const createGroqProvider = (options = {}) => createOpenAICompatibleProvider({
  id: 'groq',
  label: 'Groq',
  apiKey: options.apiKey ?? process.env.GROQ_API_KEY ?? '',
  model: options.model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  baseUrl: options.baseUrl,
  hostAllowlist: ['api.groq.com'],
  allowCustomFlag: 'GROQ_ALLOW_CUSTOM_BASE_URL'
});

export function createOllamaProvider({
  baseUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  model = process.env.OLLAMA_MODEL || 'qwen2.5:1.5b'
} = {}) {
  const id = 'ollama';
  return {
    id,
    label: 'Local Ollama',
    model,
    configured: true,
    async health() {
      try {
        const endpoint = resolveOllamaBaseUrl(baseUrl);
        const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(1800) });
        if (!response.ok) return { status: 'runtime_unavailable', provider: id, model, detail: `Ollama returned HTTP ${response.status}.` };
        const payload = await readJson(response);
        const models = Array.isArray(payload.models) ? payload.models : [];
        const wanted = String(model).split(':')[0];
        const found = models.some(item => item.name === model || item.model === model || String(item.name || '').split(':')[0] === wanted);
        return found
          ? { status: 'local_model_ready', provider: id, model, detail: `Ollama ${model} is available.` }
          : { status: 'model_missing', provider: id, model, detail: `Ollama is running but ${model} is not pulled.` };
      } catch (error) {
        return { status: 'runtime_unavailable', provider: id, model, detail: error.message || 'Ollama is not reachable. Deterministic fallback is available.' };
      }
    },
    async generate({ schema, system, prompt, temperature = 0.25, maxOutputTokens = 2200, timeoutMs = 45000 } = {}) {
      const endpoint = resolveOllamaBaseUrl(baseUrl) + '/api/chat';
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            ...(schema ? { format: schema } : {}),
            options: { temperature, num_predict: maxOutputTokens },
            messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }]
          }),
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (error) {
        if (error.name === 'TimeoutError') throw new AIProviderError('timeout', `Ollama did not answer within ${Math.round(timeoutMs / 1000)}s.`);
        throw new AIProviderError('network', `Ollama request failed: ${error.message || 'network error'}.`);
      }
      if (!response.ok) throw new AIProviderError('provider_error', `Ollama generation failed with HTTP ${response.status}.`);
      const payload = await readJson(response);
      const content = payload?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new AIProviderError('empty', 'Ollama returned an empty response.');
      if (content.length > 60000) throw new AIProviderError('oversized', 'Ollama returned an oversized response.');
      return {
        content,
        model: payload.model || model,
        provider: id,
        truncated: payload.done_reason === 'length',
        usage: { inputTokens: payload.prompt_eval_count ?? null, outputTokens: payload.eval_count ?? null }
      };
    }
  };
}

/**
 * Deterministic scripted provider. Tests inject responses through `respond`;
 * without them it replays a fixed valid plan so the whole AI path (validation,
 * persistence, approval, UI) is exercised with zero network and zero flake.
 */
export function createMockProvider({ responses = [], model = 'eventpilot-mock', baseUrl = 'http://127.0.0.1:0' } = {}) {
  const id = 'mock';
  const queue = [...responses];
  const calls = [];
  return {
    id,
    label: 'Deterministic test provider',
    model,
    configured: true,
    calls,
    async health() { return { status: 'local_model_ready', provider: id, model, detail: 'Deterministic test provider.' }; },
    async generate(request) {
      calls.push(request);
      const next = queue.length ? queue.shift() : '{}';
      if (next instanceof Error) throw next;
      if (typeof next === 'string') return { content: next, model, provider: id, usage: {} };
      return { content: JSON.stringify(next), model, provider: id, usage: {} };
    },
    push(value) { queue.push(value); }
  };
}

export function buildProvider(name, options = {}) {
  switch (String(name || '').toLowerCase()) {
    case 'gemini': return createGeminiProvider(options);
    case 'ollama': return createOllamaProvider(options);
    case 'mock': return createMockProvider(options);
    default: throw new AIProviderError('bad_config', `Unknown AI provider "${name}". Use gemini, ollama or mock.`);
  }
}
