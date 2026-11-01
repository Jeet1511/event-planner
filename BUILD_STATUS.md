# EventPilot AI — Build Status

**Build:** v6 — production path opened safely: durable Supabase persistence + workspace access
control, both verified; submission pack prepared
**Target hosting:** Render + Supabase (see `DEPLOYMENT_RENDER.md`); not yet deployed
**Release decision:** NOT DEPLOYED — no platform credentials exist in this environment

## Verified in this environment (2026-11-01, v6)

- `npm test`: **96 tests, 0 failures** under `TZ=UTC` and `TZ=Asia/Kolkata` (10 new store tests,
  8 new access-control tests, 7 new deployment-gate tests).
- **Production boot path verified end to end against a local fake PostgREST** (9/9,
  `npm run verify:prod (scripts/verify-production.mjs)`): refuses to start without a ≥16-char workspace key and names what is
  missing; boots when persistence + key are both set; every `/api` route answers 401 until the key is
  exchanged for an `HttpOnly` `SameSite=Strict` session cookie that never contains the key; a write
  in production mode lands in the database; **the event survives a full process restart**.
- Diffed writes verified: a no-op mutation issues zero database writes, a single-field change
  re-upserts exactly one row.
- Browser regression after the security work: 10/10, zero console errors, composer text still
  survives a tab switch. Live Groq still answering (plan 1.8 s, assistant turn 1.5 s).

## Not verified, stated plainly

- **No real Supabase project was contacted.** No credentials exist here, so
  `db/migrations/001_events.sql` has never been executed and the RLS deny-by-default posture is
  asserted by reading the SQL, not by running a query.
- **No deployment exists.** No Render/Vercel account, token or CLI on this machine. `render.yaml`
  describes a service; it is not evidence of one, and there is no live URL to submit.
- **Hack2Skill submission not performed.** The dashboard 404s for an unauthenticated session and this
  browser profile is logged out; I did not attempt to bypass that. Separately, all four listed
  challenges are marked Concluded and none is an event-planning problem, so the target challenge
  needs your confirmation before anything is submitted.
- Access control is **one shared workspace key**, not user authentication: no accounts, no per-event
  membership, no roles. Anyone holding the key sees every event.

## Verified in this environment (2026-11-01, v5)

- `npm test`: **73 tests, 0 failures** under `TZ=UTC` and `TZ=Asia/Kolkata`; `npm run check` clean.
- **Live free-text creation, real Groq, no mocks.** *"Birthday party for my younger brother, around
  30 people, I don't want to spend too much"* → city, budget and a cricket preference added on the
  second turn → *"actually make it 45 people and 55 thousand"* honoured as a correction (guests 45,
  budget ₹55,000, everything earlier retained). Readiness flipped only when the application's own
  check passed, and the plan then generated from that draft (7 tasks, `groq-structured`).
- **Live revision in the new voice:** *"we can stretch to 60 thousand, make it more fun for kids"* →
  four reallocations plus `add_tasks`, with prose that agrees with the proposed numbers.
- Browser pass at 1440×900, 834×1112 and 390×844: 11/11 checks, zero console errors, zero failed
  requests, zero horizontal overflow at every width. Measured: no rendered text below 13px, every
  touch target ≥24px (WCAG 2.2 SC 2.5.8), contrast across 20 element classes all ≥4.70:1, 14/14 tab
  stops showing a focus ring.
- Client is 24 KB Brotli in total (`app.js` 17.2 KB + `styles.css` 6.8 KB), still zero dependencies
  and still one request each.

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

- **v5 voice is improved but not uniform.** With the register example and the explicit "do not list
  the numbers back" rule, most replies read like a person; gpt-oss-20b still occasionally opens with
  "We've updated the guest count to…" — a tone slip, not a correctness failure, and it costs a second
  prompt pass to chase. Not fixed by a validator because prose style is not a data contract.
- **v5 pre-event conversation is held in the browser tab.** `plannerHistory` and the draft live
  client-side so the server stays stateless; reloading the landing loses the thread. Persisting it
  would need a draft record in the store, which is a schema change rather than a small one.
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
