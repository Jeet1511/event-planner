# Trial 15 — Implementation Report

## Scope executed

The supplied Trial 15 specification was treated as an implementation target, not as evidence that the baseline already satisfied it. The baseline project was extracted and tested before changes. The existing dependency-free Node application was retained to avoid an unverified framework rewrite in an offline environment.

## Baseline

- Node.js v22.16.0 and npm 10.9.2.
- Original test suite: 6 passed, 0 failed.
- Original `npm run check`: passed.
- Confirmed architecture: built-in Node HTTP server, browser JavaScript/CSS, JSON-file persistence, draft Supabase migration and optional unstructured Ollama `/api/generate` suggestions.

## Changes

### GenAI contract

Added `src/ai.mjs`:
- Provider health checks `/api/tags` and verifies the configured model is present.
- Uses Ollama `/api/chat` with a JSON Schema output contract.
- Enforces bounded fields and task deadline ranges at runtime.
- Rejects malformed output, empty task/idea lists and budget percentage totals that do not reconcile to 100%.
- Keeps user event data in a delimited data block and explicitly prohibits invented vendor facts.
- Returns validated assumptions, missing information, budget proposals, tasks, ideas, vendor checklists and risks.

The HTTP plan route uses the structured proposal when the local provider succeeds. Otherwise, the deterministic plan remains available and the response reports fallback mode. The UI distinguishes AI proposals from template plans and asks the user to review and confirm before saving a new plan.

### Domain and budget

- Date-only due-date calculations now use UTC calendar arithmetic, avoiding host-local timezone drift.
- AI budget shares are converted to INR amounts with integer paise reconciliation.
- Budget categories can be created, renamed, reallocated and deleted if no expenses refer to them.
- Category allocation edits do not silently redistribute other categories; the total can visibly remain under- or over-allocated.

### Local reliability and UI

- Local JSON writes use a temporary file followed by rename; the in-process queue can recover after a prior write failure.
- Request body size is bounded to 8 MiB.
- Event cards support keyboard activation.
- Sidebar reports local AI readiness based on the runtime health response.

### Database migration draft

Added `supabase/migrations/0002_security_hardening.sql` to address selected issues in the supplied draft: client-writable audit records, spoofable expense actor, quotation/vendor cross-event integrity, private storage object policies, profile records, event-scoped AI persistence metadata and document metadata. It has not been run against PostgreSQL/Supabase. It is not a substitute for migration execution and RLS negative testing.

## Tests

Added `test/ai.test.mjs` for structured proposal validation. Extended core and HTTP integration tests for date arithmetic, AI health status and budget category CRUD.

Commands executed:

```bash
npm run check
TZ=UTC npm test
TZ=Asia/Kolkata npm test
```

Both test runs: 17 passed, 0 failed. The integration suite confirms the local HTTP workflow and category operations. It does not prove hosted security, browser accessibility or production readiness.

## Blockers and residual risk

- No Ollama executable/runtime or model is available in this environment; actual model generation is unverified.
- No Supabase credentials, Supabase CLI or PostgreSQL client are available; migrations and RLS behavior are unverified.
- The running application remains unauthenticated and JSON-backed. Do not expose it beyond loopback or use sensitive real-world data.
- Windows, browser UI, screen-reader, WCAG 2.2 AA, load, backup/restore, multi-process concurrency and production deployment were not tested.
- The AI feature is structured plan generation, not yet a persistent conversational planning assistant with approved action diffs.

See `BUILD_STATUS.md` for the release-gate status and outstanding work.

## Additional authorized diagnostic

A one-shot Gemini `gemini-2.5-flash` connectivity request was attempted using the user-supplied key solely as an external diagnostic; the key was not written to the project. The execution environment could not resolve `generativelanguage.googleapis.com` (DNS resolution failure), so no HTTP response was received. This is an environment/network block, not evidence that the key is invalid. Gemini is not wired into the application because Trial 15 requires local Ollama as the default and prohibits silent external transmission of event data.


## Architecture decision update (2026-11-01)
The project owner selected Render as the hosting platform and does not intend to use Supabase. Supabase references above are historical trial context only and are superseded by `DEPLOYMENT_RENDER.md`.
