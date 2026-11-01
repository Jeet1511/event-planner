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
- [x] Natural-language event brief → extracted, editable, confirmed fields
- [x] AI plan: strategy, budget shares, dependent timeline, vendor why/when, risks, ideas
- [x] Event-context planning assistant with approve/dismiss action proposals
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
- [ ] Authentication and multi-user roles in running prototype (critical blocker)
- [ ] Render PostgreSQL integration, application authentication and tenant authorization
- [ ] Secure cloud document storage and malware scanning
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

Frontend budget: 55.8 KB of `app.js` + 18.2 KB of CSS, zero dependencies, zero build step, one
module request. There is no framework, so there is no hydration, no code-splitting decision and no
bundle graph to audit — the whole client is smaller than one typical React app shell.

## Deployment target: Render

Render is the selected hosting platform. See [`DEPLOYMENT_RENDER.md`](DEPLOYMENT_RENDER.md) for the target architecture and release blockers. Do not deploy this build publicly: it deliberately refuses production startup and non-loopback binding until authentication, tenant authorization and PostgreSQL persistence are implemented.

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
