# EventPilot AI — Build Status

**Build:** v2 — Groq-backed GenAI planning assistant, performance pass applied
**Target hosting:** Render (still blocked; see below)
**Release decision:** NOT PRODUCTION READY — deployment intentionally blocked

## Verified in this environment (2026-11-01)

- Node.js v24.21.0 on Windows.
- `npm test`: **63 tests, 0 failures** under `TZ=UTC` and `TZ=Asia/Kolkata`.
- `npm run check`: passes (server, all `src/` modules, browser client).
- **Live Groq generation, real calls, no mocks:** natural-language brief → extracted fields
  (250 guests, ₹8,00,000, Kolkata, Bengali-traditional, vegetarian) → 4 focused follow-up
  questions → full structured plan (strategy, budget, timeline with dependencies, vendor
  requirements with why/lead-time/criteria, ideas, risks). Model `openai/gpt-oss-20b`; budget
  shares reconciled to **exactly 80000000 paise** against an ₹8,00,000 total.
- Provider health correctly distinguished `remote_model_ready` from `model_missing` (the key did
  not list `llama-3.3-70b-versatile`) and from HTTP 404 on a wrong base URL.
- Rate-limit behaviour observed live: Groq free tier returned HTTP 429 → the app answered 503 with
  `keepExistingData: true`, wrote no conversation, and left the saved plan untouched.
- Browser walkthrough (headless, 1440×900 and 390×844) of intake → plan review → save → assistant
  proposal → approve → dismiss → vendor status → keyboard dialog open/Escape.
- Performance before/after measured on a seeded 40-event store; see the table in `README.md`.
  List payload 616,451 → 20,231 bytes; list p50 10.2 → 3.3 ms; heap after bench 37.5 → 16.6 MB.

## Implemented since Trial 15

- Provider layer (`src/ai-providers.mjs`): Groq (OpenAI-compatible JSON mode), Gemini
  (`responseSchema`, key in `x-goog-api-key` header only), Ollama, and a deterministic mock used by
  every automated test. Selection is env-driven; `auto` never picks local Ollama.
- SSRF and leak guards: Gemini/Groq hosts are allowlisted unless an explicit opt-in flag is set;
  link-local metadata addresses are refused; outbound error text is redacted of URLs and keys.
- `.env` is loaded at startup without overriding variables the shell already set.
- Structured contracts and validators for three output shapes (plan, intake, assistant turn), each
  with one controlled recovery pass; malformed output can never reach storage.
- `src/planning.mjs`: paise-exact largest-remainder allocation, overdue clamping with dependency
  repair and honest conflict warnings, change-impact analysis with blockers, per-operation
  validation against real record ids, and additive application of approved proposals.
- Approval workflow: the assistant proposes typed actions, deterministic code screens them, the user
  approves or dismisses, and approval re-validates against the **persisted** event fingerprint.
- Guest names and contact details are excluded from every prompt; only aggregate counts are shared.

## Not implemented / not verified

- **No authentication, no per-event authorization, no tenant isolation.** Loopback binding and the
  production-startup refusal are still enforced by `src/deployment.mjs`. Do not expose this build.
- Render PostgreSQL, migrations, private object storage and malware scanning are not implemented.
- Unapproved AI proposals live in server memory and are lost on restart (documented in the UI).
- A **live Groq assistant turn that produced actions has not been observed**: the two attempts hit
  the free-tier 429 limit. The approve/dismiss path is verified against the deterministic mock and
  the scripted demo provider only.
- Gemini has never been exercised against the real Google endpoint (no Gemini key configured); its
  adapter is verified against a local fake Gemini server (`test/gemini.test.mjs`).
- Screen-reader testing, full WCAG 2.2 AA audit, load/concurrency testing, backup/restore and
  multi-process concurrency are not done. The final visual re-audit after the last UI fixes
  (aria-labels on 5 inline fields, mobile nav wrap, contrast corrections) was not re-run.
- Model output quality is not benchmarked; structure and arithmetic are validated, taste is not.

## Release gate

Do not expose or deploy this version. `data/events.json` is a local demo store. The deployment guard
is a safety barrier, not a substitute for the missing production controls.

See `DEPLOYMENT_RENDER.md` for the target architecture and `docs/QUALITY_GATES.md` for the six-gate
acceptance policy.
