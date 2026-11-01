# Supreme Courtroom — Trial 14: Six mandatory quality gates

Date: 2026-11-01
Artifact inspected: `eventpilot-ai-mvp.zip` (offline local prototype)

## Objective
Make Code Quality, Security, Efficiency, Testing, Accessibility and Problem Statement Alignment mandatory, evidence-based release gates.

## Independent verification performed

Commands executed in the extracted project:

```sh
npm test
npm run check
```

Observed result:
- `npm test`: 6 tests passed, 0 failed.
- `npm run check`: Node syntax checks for server, core module and browser application completed successfully.

These tests ran in the available Linux container. Windows-native execution, browser E2E, real PostgreSQL/Supabase execution, RLS verification, load testing and assistive-technology testing were not performed.

## Prosecution findings

### Critical — Security gate fails for production use
- The running prototype has no authentication or multi-user authorization.
- `GET /api/events` returns all locally stored events to any caller able to reach the server.
- Local JSON persistence is plaintext and is not a tenant-isolated datastore.
- The server can be configured to bind to a non-loopback host through `HOST`; doing so exposes unauthenticated event data and mutations to that network.
- The Supabase migration is a draft and has not been applied or tested against PostgreSQL.

Impact: unauthorized disclosure or modification of event, guest, vendor and quotation data if the server is exposed or shared.

### High — Accessibility gate fails
- Event cards are clickable `<article>` elements, not keyboard-operable links/buttons.
- Dialog implementation lacks demonstrated focus containment, initial focus, Escape handling and focus restoration.
- Multiple inline form controls rely on placeholders rather than persistent labels.
- Navigation buttons and tab-like controls do not expose complete semantic roles/states.
- Progress bars do not expose accessible values/names.
- No automated WCAG scan or manual screen-reader/keyboard test evidence exists.

Impact: keyboard and assistive-technology users may be unable to complete key workflows.

### High — Reliability and data durability weaknesses
- JSON persistence is a local demonstration store, not transactional production storage.
- File writes are not an atomic replace/backup strategy; a process or disk failure during overwrite can corrupt the JSON store.
- A rejected `writeQueue` promise can poison subsequent queued writes unless the chain is recovered.
- No load, crash-recovery or Windows-native test evidence exists.

### Medium — Code quality and test coverage
- Prototype uses dependency-free Node HTTP rather than the approved Next.js/Supabase production architecture.
- Six test cases cover useful core paths but do not prove authorization, accessibility, database constraints, browser behavior or production reliability.
- No TypeScript, lint, production bundle, dependency audit or CI evidence exists for this prototype.

### Problem statement alignment
Partial pass: all three event types, local budget/task/vendor/quotation/guest workflows and deterministic fallback planning exist in the artifact. However, live vendor discovery/verification and real generative AI behavior were not validated. The prototype correctly labels user-entered vendors and quotations as unverified and provides an offline fallback.

## Defense response
The artifact remains useful as a local functional demonstration. Its loopback default, explicit README warnings, input validation, escaping, upload signature checks and six passing tests reduce some risks in that limited context. They do not satisfy production multi-user security or WCAG conformance.

## Judge ruling
RETURN FOR CORRECTION for any claim of full six-gate compliance or production MVP readiness.

- Code Quality: PARTIAL / NOT PASSED
- Security: FAIL
- Efficiency: NOT TESTED / PARTIAL
- Testing: PARTIAL
- Accessibility: FAIL
- Problem Statement Alignment: PARTIAL PASS

No absolute defect-free claim is made. The prototype may be used only as a local demonstration with non-sensitive synthetic data, bound to loopback. Do not expose it to a LAN or public network.

## Required next corrections
1. Move to authenticated Next.js + Supabase architecture; apply and test RLS against a real test database.
2. Add tenant/role negative tests and protect audit-log integrity.
3. Replace JSON persistence with transactional PostgreSQL; add safe file storage and scanning.
4. Remediate keyboard, dialog, label, progress and navigation semantics; run axe plus manual WCAG 2.2 AA checks.
5. Add browser E2E, Windows-native, load, failure-recovery and provider-outage tests.
6. Complete three event-type acceptance journeys and retain provenance for all vendor/quotation claims.

## Release decision
Not approved for production. Local prototype verification only. The six quality gates are now binding for every subsequent version.


## Architecture decision update (2026-11-01)
The project owner selected Render as the hosting platform and does not intend to use Supabase. Supabase references above are historical trial context only and are superseded by `DEPLOYMENT_RENDER.md`.
