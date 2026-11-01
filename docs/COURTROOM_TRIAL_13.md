# Supreme Courtroom — Trial 13 Report

**Project:** EventPilot AI MVP  
**Market:** India  
**Target developer environment:** Windows 10/11  
**AI budget:** Free/local-first  
**Verdict:** APPROVED WITH CONDITIONS for local demonstration only; NOT approved for production.

## Original objective

Inspect the available workspace, reuse suitable open-source projects, assemble a working EventPilot AI MVP, run tests and continue adversarial review without claiming unexecuted verification.

## Workspace and dependency evidence

- The available workspace was empty; no pre-existing project or Git repository was found.
- The execution container was Linux with Node.js v22.16.0, npm 10.9.2, Git 2.47.3 and Python 3.13.5.
- GitHub and npm registry name resolution failed (`Could not resolve host`), so no external repository could be cloned and no npm dependencies could be installed.
- The implementation therefore uses Node.js built-ins as an offline local prototype. This is an explicit deviation from the approved Next.js/Supabase production architecture, not a claim that the target architecture is complete.

## Implemented

- Event creation for weddings, birthdays and community events.
- Deterministic INR budget allocation with paise-level arithmetic.
- Expense recording, budget summaries and expense idempotency keys.
- Task checklist with due dates, priorities and completion status.
- Manual vendor records with unverified status.
- Quotation comparison and optional PDF/JPEG/PNG attachments (5 MB limit, file signature checks, private local storage).
- Guest list and RSVP status.
- Optional local Ollama suggestions; deterministic template fallback if Ollama is absent.
- Responsive HTML/CSS/JavaScript dashboard.
- Local JSON persistence, loopback-only binding by default, serialized write handling, basic Origin/content-type checks and security headers.
- Draft Supabase PostgreSQL schema with event membership roles, expense idempotency, RLS policies and owner immutability trigger.
- Windows PowerShell launcher and run instructions.

## Major weaknesses and judicial findings

1. **No authentication in the running prototype — CRITICAL.** Localhost-only is not multi-user security. Do not expose it to a LAN or public internet.
2. **Plaintext local JSON — HIGH.** Guest contacts and event information are not encrypted; use synthetic data only.
3. **Supabase integration and RLS are not executed — CRITICAL for production.** Migration is a draft and requires review in a real Supabase project, policy tests, storage policies and backup/retention decisions.
4. **No malware scanning — HIGH.** File signature checks only validate basic file format markers; they do not make uploaded documents safe.
5. **No real vendor discovery — HIGH.** Vendor and quote records are user-entered and remain unverified.
6. **Ollama was not installed or run — MEDIUM.** Offline fallback is verified; local LLM output quality and resource requirements remain untested.
7. **No Windows-native runtime test — MEDIUM.** The code is Windows-compatible by design, but current execution was on Linux.
8. **No browser visual regression — MEDIUM.** Chromium headless did not exit within the available execution window; HTTP/static asset smoke tests passed.
9. **No PostgreSQL parser/runtime available — HIGH for migration confidence.** SQL migration was inspected but not applied or executed.
10. **No real email, payments, bookings or external vendor API integrations.** These remain explicitly deferred.

## Corrections made during this trial

- Avoided pretending a GitHub starter was cloned when network access was unavailable.
- Built a dependency-free local prototype to make progress without npm/GitHub access.
- Added server-side event validation and date checks.
- Added serialized write handling to avoid overlapping local JSON read-modify-write operations.
- Added expense idempotency keys and conflict detection for key reuse with different payloads.
- Added Origin and JSON content-type checks for write requests.
- Added upload size and file signature checks; attachments are kept outside the static directory.
- Added basic security headers and loopback-only default binding.
- Documented limitations prominently.

## Validation actually performed

Commands executed in the project directory:

```text
npm test
npm run check
```

Results:

- `npm test`: 6 top-level test groups passed, 0 failed. Coverage includes budget allocation, input validation, all three event templates, budget summary arithmetic, expense category validation, HTTP workflow, concurrent event creation, cross-origin write rejection, duplicate expense idempotency, quotation file signature rejection, and local AI fallback behavior.
- `npm run check`: passed. Node syntax checks completed for `server.mjs`, `src/core.mjs` and `public/app.js`.
- HTTP smoke checks: `/api/health`, `/`, and `/app.js` returned HTTP 200.
- Browser visual check: attempted with headless Chromium; timed out and is not counted as passed.
- Windows PowerShell: not executed in this Linux container.
- PostgreSQL migration: not executed.

## Final decision

**APPROVED WITH CONDITIONS — local demonstration only.** The prototype demonstrates the principal planning workflow and passes its implemented Node tests. It is not a secure, production-ready multi-user service. Production approval requires the Next.js/Supabase integration, tested RLS, authentication and membership flows, secure document storage/scanning, PostgreSQL migration tests, Windows-native verification, browser E2E testing, privacy review and a verified vendor data source.


## Architecture decision update (2026-11-01)
The project owner selected Render as the hosting platform and does not intend to use Supabase. Supabase references above are historical trial context only and are superseded by `DEPLOYMENT_RENDER.md`.
