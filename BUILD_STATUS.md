# EventPilot AI — Build Status

**Build:** v4 — Groq-backed planning assistant in a permanent right-hand rail; AI token cost halved
**Target hosting:** Render (still blocked; see below)
**Release decision:** NOT PRODUCTION READY — deployment intentionally blocked

## Verified in this environment (2026-11-01, v4)

- Node.js v24.21.0 on Windows.
- `npm test`: **68 tests, 0 failures** under `TZ=UTC` and `TZ=Asia/Kolkata`.
- `npm run check`: passes (server, all `src/` modules, browser client).
- **Live Groq assistant turns that propose real actions, observed end to end** — the gap that was
  open in v3 is closed. Three consecutive turns answered in 0.8–2.0 s with 4, 1 and 1 accepted
  actions and a deterministic before/after money table; a fourth turn ("the photographer cancelled")
  produced `update_task` + 2 `add_tasks` + a reallocation, and approving it from the rail changed the
  stored plan. The earlier failure was not the model: it was token cost against an 8,000 TPM free
  tier plus a provider 400 that the recovery pass reproduced verbatim.
- **Live plan generation:** 1,458 tokens (650 prompt + 808 completion) versus 2,978 before, model
  `openai/gpt-oss-20b`, shares reconciled to exact paise.
- **Honest failure path, live:** when the burst exceeded the per-minute budget the API answered
  `429` with `retryAfterSeconds: 11` and a `retry-after` header; the rail rendered the reason, the
  countdown and a Try again button, and wrote nothing.
- Browser walkthrough (headless, 1440×900 and 390×844) of the redesigned workspace: intake → plan
  review → save → chat in the rail → approve → dismiss → tab switching with the composer text intact →
  mobile bottom sheet. 13/13 behaviour checks, 0 console errors, 0 failed requests, 0 px of horizontal
  overflow.
- Keyboard: 14/14 tab stops render a visible focus ring; contrast measured per element — the primary
  button was **3.65:1 (failing AA)** on vivid marigold, so labelled marigold surfaces moved to
  `#a35a06` (5.22:1); every other measured pair is ≥4.65:1.

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
- v4 interface: the workspace is an icon rail, the plan, and a **permanent planner rail** on the
  right — the assistant is no longer a page you navigate to. The composer lives in static DOM, so a
  re-render never eats your half-typed message; proposals are approved inside the conversation that
  produced them; the four metric cards that repeated under every tab became one chip row. Below
  900px the rail is a bottom sheet behind an "Ask your planner" button.
- v4 defects found by probing and then fixed with a regression test each:
  - `add_tasks` accepted only a day offset, so a model-supplied absolute `dueDate` rejected the
    **whole** operation and the user's request silently did nothing. Absolute dates are now resolved
    in code (clamped to today and to the event date), an impossible date is still refused with a clear
    reason, and a dated task is no longer labelled "undated".
  - Groq answers HTTP 400 "Failed to validate JSON" when the reply is cut off by `max_tokens`. The
    recovery pass resent the identical request and was therefore guaranteed to fail again; a
    truncation now doubles the cap once.
  - A quota refusal was reported to the user as "The AI request failed." and answered 503. It is now
    `429` + `retry-after` + `retryAfterSeconds` + the provider's own redacted reason, rendered in the
    rail with a countdown.
  - The nested `tasks` and `ideas` item shapes inside the assistant contract were free-form objects,
    so the model had to guess field names. They are now declared.

## Not implemented / not verified

- **No authentication, no per-event authorization, no tenant isolation.** Loopback binding and the
  production-startup refusal are still enforced by `src/deployment.mjs`. Do not expose this build.
- Render PostgreSQL, migrations, private object storage and malware scanning are not implemented.
- Unapproved AI proposals live in server memory and are lost on restart (documented in the UI).
- Sustained chat is still quota-bound: three turns in a row fit the free tier, a fourth could return
  429 with an 11-second wait. The app now says so instead of failing silently; raising the ceiling
  needs a paid tier or a second key, which is the user's decision.
- Gemini has never been exercised against the real Google endpoint (no Gemini key configured); its
  adapter is verified against a local fake Gemini server (`test/gemini.test.mjs`).
- Screen-reader testing and a full WCAG 2.2 AA audit are not done. Automated contrast, focus-ring,
  overflow and console checks are (see above); axe has not been run.
- Model output quality is not benchmarked. Structure and arithmetic are validated; taste is not. One
  measured weakness: asked to cut ₹18 lakh to ₹14 lakh, the model proposed allocations summing to
  ₹16.8 lakh and described the result as ₹14 lakh. The deterministic table shows the true total, so
  the user sees the discrepancy rather than the model's claim.

## Release gate

Do not expose or deploy this version. `data/events.json` is a local demo store. The deployment guard
is a safety barrier, not a substitute for the missing production controls.

See `DEPLOYMENT_RENDER.md` for the target architecture and `docs/QUALITY_GATES.md` for the six-gate
acceptance policy.
