# EventPilot AI — offline MVP prototype

Windows-compatible, dependency-free local prototype for planning weddings, birthdays and community events in India. Features include INR budgets and expenses, editable budget categories, tasks, manual vendor records, quotation comparison, guest RSVPs and structured AI planning proposals through Groq, Gemini or a local model you opt into.

> **Important:** This is a local demonstration, not the approved production architecture. It has no authentication, multi-user authorization, hosted database or production-grade document malware scanning. It binds to `127.0.0.1` and stores event/guest data as plaintext JSON. Do not expose it to a network or enter real guest contact details, sensitive contracts or confidential information. Render is the intended hosting platform, but this build is not yet deployable: authentication and PostgreSQL persistence must be implemented first.

## Requirements and run

- Windows 10/11
- Node.js 20.9 or newer (Node 22 recommended)
- No npm packages required

In PowerShell, from the project directory:

```powershell
npm test
npm run check
npm start
```

Open http://127.0.0.1:3000. Stop with Ctrl+C. Alternatively run `.\run-windows.ps1` from PowerShell.

## Which AI provider

One AI orchestration layer (`src/ai.mjs`) sits behind every AI feature. The provider is chosen
by the `EVENTPILOT_AI_PROVIDER` variable in `.env`: `auto` (default), `groq`, `gemini`, `ollama`,
`mock` or `none`. Nothing in the app knows which model answered.

`auto` uses a cloud key if one exists (Groq, then Gemini) and otherwise stays deterministic.
**Local Ollama is never selected automatically** — running a model on this machine is a
deliberate, resource-heavy choice you have to opt into.

### Groq (current default, free tier)

1. Create a key at https://console.groq.com/keys
2. Put it in `.env` (gitignored, never sent to the browser):

```ini
GROQ_API_KEY=gsk_your_key_here
GROQ_MODEL=openai/gpt-oss-20b
EVENTPILOT_AI_PROVIDER=auto
```

3. `npm start` → the sidebar pill reads “Groq connected”.

`GROQ_MODEL` must be a model your account lists; `/api/health` reports `model_missing` if it is
not. `GROQ_ALLOW_CUSTOM_BASE_URL=true` is required before any other base URL will be accepted.

### Gemini (alternative cloud provider)

Set `GEMINI_API_KEY` (from Google AI Studio) and optionally `GEMINI_MODEL`. The key is sent only
in the `x-goog-api-key` header, never in a URL.

### Local Ollama (opt-in)

```powershell
$env:EVENTPILOT_AI_PROVIDER = "ollama"
$env:OLLAMA_MODEL = "qwen2.5:1.5b"   # small by design; ~1 GB download
npm start
```

Remote Ollama endpoints are blocked by default; only set `OLLAMA_ALLOW_REMOTE=true` when you
deliberately trust that endpoint with event data.

In every case: AI output is a **suggestion**. It cannot establish vendor identity, prices, reviews
or availability; financial totals, remaining balance, percentages and dates are always computed in
integer paise and calendar arithmetic by `src/core.mjs` and `src/planning.mjs`. A generated plan is
reviewed before saving, and assistant changes are applied only after you approve them.
`node scripts/demo-server.mjs` runs the whole workflow offline on scripted responses (labelled
“Test AI”) — it contains no model.

## Feature status

- [x] Wedding, birthday and community templates
- [x] **Talk-to-create**: the planner answers in the rail before any event exists, accumulates
  details across turns ("actually make it 45 people and 55 thousand" is understood as a correction),
  and offers a plan when enough is known — no modal, no mandatory option
- [x] Natural-language event brief → extracted, editable, confirmed fields
- [x] AI plan: strategy, budget shares, dependent timeline, vendor why/when, risks, ideas
- [x] Event-context planning assistant with approve/dismiss action proposals, permanently docked in
  a right-hand rail beside every workspace view (not a page you navigate to)
- [x] Targeted revisions (budget, timeline, vendors, ideas, risk) that preserve untouched records
- [x] INR budget allocation using integer paise arithmetic (largest-remainder, exact totals)
- [x] Expense recording, budget summaries and deterministic plan-health checks
- [x] Task checklist with dates, priorities, overdue detection and completion state
- [x] Manual vendor records, booking status and quotation comparison
- [x] Optional PDF/JPEG/PNG quotation attachment (5 MB cap, file signature check; no malware scan)
- [x] Guest list and RSVP status (never sent to a model; only aggregate counts are)
- [x] Provider health distinction and proposal provenance labels
- [x] Editable budget category names and allocations
- [x] Review-and-confirm step before saving a newly generated plan
- [x] Responsive dashboard, keyboard flows, labelled controls, reduced-motion support
- [x] Node built-in unit, integration, AI-contract and performance tests
- [x] Durable Supabase Postgres persistence (verified against a fake PostgREST; data survives a restart)
- [x] Workspace access key gating every API route, with revocable HttpOnly sessions
- [ ] Per-user accounts, event membership and roles — one shared key today, so anyone with the key
      sees every event (critical blocker for a real product, acceptable for a single demo)
- [ ] Real Supabase project exercised (no credentials here; the migration has never been executed)
- [ ] Secure cloud object storage and malware scanning for quotation uploads
- [ ] Email invitations/reminders
- [ ] Live vendor discovery or booking
- [ ] Calendar drag/drop and notifications
- [ ] Persistent (across restart) pending AI proposals — unapproved proposals live in memory only

## Performance

Measured, not assumed, on a seeded 40-event store (40 events × 14 tasks × 25 guests × 6 expenses),
before and after the v2 pass, all on `127.0.0.1`:

| Endpoint | Before p50 / p95 | After p50 / p95 | Before wire | After wire |
| --- | --- | --- | --- | --- |
| `GET /api/events` | 10.2 / 15.6 ms | 3.3 / 7.1 ms | 616,451 B | 20,231 B |
| `GET /api/events/:id` | 4.2 / 5.7 ms | 1.1 / 1.4 ms | 27,211 B | 16,854 B |
| `POST …/tasks` | 9.7 / 19.7 ms | 6.5 / 9.3 ms | 30,701 B | 20,344 B |
| `POST …/assistant` | 13.2 / 16.4 ms | 7.6 / 15.1 ms | 34,993 B | 34,993 B |
| process heap after bench | 37.5 MB | → | | 16.6 MB |

What changed:

- **Response shaping.** The list endpoint now sends only what a card renders (name, dates, task
  counts, budget summary, plan health) instead of every task description, strategy, proposal and
  guest record in the workspace.
- **Compression.** JSON and static assets are gzipped/deflated when the client accepts it, with
  `vary: Accept-Encoding`; static files are Brotli-compressed **once** and cached per file version.
- **Revalidation.** Static assets carry an ETag; `max-age=0, must-revalidate` means an unchanged
  55 KB bundle is a 304 with zero bytes instead of a re-download.
- **One parsed store per process.** `events.json` is parsed once and reused; the cache is dropped the
  instant a write fails so memory can never drift from disk.
- **No read-after-write refetch.** A mutation response now carries what the list card needs, so
  ticking a checkbox updates in place instead of re-downloading every event (6 removed requests per
  session interaction pattern).
- **Conversation is fetched by the view that shows it**, not embedded in every event payload.
- **Bounded concurrency.** At most one live generation (tune with `EVENTPILOT_AI_CONCURRENCY`), a
  bounded wait queue, a per-client AI request budget (`EVENTPILOT_AI_RATE_LIMIT_PER_MINUTE`, default
  30/min) and a 60-message conversation cap so prompts and the store cannot grow without limit.

`test/performance.test.mjs` asserts these as gates: payload shape, compressed wire bytes, ETag/304
behaviour, p95 latency at 40 events, read-cache invalidation and the bounded AI queue. It reads raw
`http` responses because `fetch` decompresses silently and would measure nothing.

Frontend budget: 70.5 KB of `app.js` + 34 KB of CSS + 11 KB of HTML, **24 KB Brotli for the whole
client**, zero dependencies, zero build step, one module request each. There is no framework, so
there is no hydration, no code-splitting decision and no bundle graph to audit — the entire client
is smaller than one typical React app shell. `test/performance.test.mjs` gates the two files
individually *and* combined, so growth in one has to be paid for out of the other.

## Design direction

The interface was rebuilt against the local `motionsites.ai` prompt library (132 hero/landing
specs). Four candidates were read in full and compared; the direction taken is a **three-zone
workspace with numeral-first hierarchy**, adapted from the Nexar spec's structure, plus the
allocation/progress drawing vocabulary of the crypto-wealth spec — the only information-visual
language in the library (hand-written SVG area marks, progress rings, label/value rows). What was
deliberately *not* taken: video backgrounds, glassmorphism, gradient headlines, rotated cards.

The library also documents itself as a trap: the same devices recur regardless of subject
(`backdrop-blur` in 64 of 132, one italic accent word inside a serif headline in 46, ALL-CAPS
tracked micro-labels in 30, three identical cards in 18, UI text at 9–11px in 12). Those counts are
why this interface has **no text smaller than 13px**, no eyebrow label above a heading, no italic
word in a headline, and one bar/ring primitive reused everywhere instead of a card kit.

Type: an old-style serif (Iowan Old Style → Palatino Linotype → Georgia, all already on the machine,
nothing downloaded) for the event name, panel titles and the planner's own voice; the system UI face
for controls and data, with tabular numerals on every rupee figure. Colour: bottle-green ink on bone
paper, with marigold reserved for the AI alone — rail edge, proposals, send button, focus ring.

### AI token cost (the reason chat used to appear dead)

Groq's free tier allows this key **8,000 tokens per minute**. The first measured plan call cost
2,978 tokens (1,050 prompt + 1,928 completion, of which 338 were the model thinking out loud), so
one plan ate over a third of a minute's budget and the automatic recovery pass was then refused
with HTTP 429. Measured on the live key after the fix:

| Call | Before | After | Change |
| --- | --- | --- | --- |
| plan prompt tokens | 1,050 | 650 | −38% |
| plan completion tokens | 1,928 | 808 | −58% |
| plan total tokens | 2,978 | **1,458** | −51% |
| reasoning tokens | 338 | 6 | −98% |
| assistant turn latency | 429 / fail | **0.8–2.0 s** | usable |

What changed, each with a measurement behind it:

- **The JSON Schema left the prompt.** Groq's `json_object` mode cannot enforce a schema, so the
  2,432-character schema document was pure token cost. It is now derived into a one-line type
  signature (`{tasks:[{title:s,…}]}), which is smaller *and* clearer. Providers that can enforce
  structure (Gemini `responseSchema`, Ollama `format`) still receive the real schema object.
- **`reasoning_effort: low`** for `openai/gpt-oss` models: 338 reasoning tokens became 6.
- **Right-sized output caps** (plan 3,000 → 1,600, assistant 2,500 → 1,200, intake 1,200 → 900)
  plus terseness rules in the prompt. The cap is not a cliff: a truncated reply now doubles the cap
  once instead of resending an identical request.
- **Prompt context trimmed**: open tasks capped at 14 with titles capped at 90 characters, and
  conversation history in the prompt capped at 8 messages × 400 characters (the stored history keeps
  its own 60-message limit).

A real cost reduction, not a cosmetic one: the same minute now fits about five generations instead
of two, which is the difference between a chat that answers and a chat that silently falls back to
templates.

## Deployment

See [`DEPLOYMENT_RENDER.md`](DEPLOYMENT_RENDER.md) for the Supabase + Render target, the environment
contract and the release order. The startup guard is conditional now: `NODE_ENV=production` and a
non-loopback bind are allowed **only** when durable persistence and `EVENTPILOT_ACCESS_KEY` (≥16
characters) are both configured, and every API route then answers 401 until that key is exchanged
for an HttpOnly session cookie. An incomplete deployment fails at boot instead of coming up as a
public, unauthenticated database of other people's events.

Not deployed: no Render, Vercel or Supabase credentials exist in this environment. The production
path is verified against a local fake PostgREST (`npm run verify:prod (scripts/verify-production.mjs)`, 9/9), including data
surviving a process restart — that is not the same as a live URL, and none is claimed.

## Repository reuse decision

GitHub and npm registry DNS were unavailable in the build environment. No third-party repository was cloned and no external package was installed. The local prototype uses Node built-ins so it remains runnable offline; it does not claim that a starter repository was integrated.

For the next online-enabled integration stage, evaluate:

- Next.js: https://github.com/vercel/next.js
- shadcn/ui (MIT): https://github.com/shadcn-ui/ui
- FullCalendar Standard (MIT; Premium scheduler features need a separate license): https://github.com/fullcalendar/fullcalendar

The current implementation remains a dependency-free local prototype while the Render production data plane is being designed.

## Security and data notes

- Local JSON persistence is demonstration-only, not concurrency-safe and not encrypted.
- Server binds to loopback (`127.0.0.1`). Do not set `HOST=0.0.0.0`.
- Quotation files are stored under `data/private-uploads`, not served as static files. No malware scanning is performed.
- Vendor and quotation details are user-entered and unverified. No live vendor search occurs.
- Render PostgreSQL is the target database. No production database connection or schema migration is implemented in this build.
- No legal compliance determination is made; obtain an India-specific privacy and consumer-law review before public launch.

## Trial 15 implementation status

See [`BUILD_STATUS.md`](BUILD_STATUS.md) and [`docs/TRIAL_15_IMPLEMENTATION_REPORT.md`](docs/TRIAL_15_IMPLEMENTATION_REPORT.md) for exact implemented items, commands, test evidence and unresolved release blockers. The current build is **not production-ready**: runtime authentication/tenant isolation and PostgreSQL persistence are not implemented. Keep the server bound to `127.0.0.1`; do not expose it to a network or enter real guest contacts or confidential contracts.

## Tests

```powershell
npm test
npm run check
```

Tests cover budget arithmetic, event validation, all three templates, expense-category validation and a local HTTP workflow. They do not prove production security, database authorization correctness, Windows runtime compatibility or AI quality.
