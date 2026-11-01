# EventPilot AI — Mandatory MVP Quality Gates

Status: binding acceptance policy for every release candidate. Current release candidate verdict: NOT PRODUCTION READY; see BUILD_STATUS.md and COURTROOM_TRIAL_15_FINAL.md. A gate is not passed by design claims or by tests that were not executed. Evidence must be attached to the exact commit/build being reviewed.

## Release rule

All six gates are mandatory. Any unresolved Critical or High severity defect in security, data integrity, core functionality, or accessibility blocks release. A partial pass is not a pass. Deferred functionality must be explicitly excluded from the MVP acceptance scope and must not be represented as implemented.

## 1. Code quality

Required evidence:
- Reproducible clean install from the lockfile and clean production build.
- Type checking and linting with zero errors; warnings must be reviewed and documented.
- Clear domain boundaries for events, budgets, expenses, tasks, vendors, quotations, guests, AI and authorization.
- Runtime validation at every external boundary; no trust in browser-provided IDs, roles, totals or ownership.
- No committed secrets, debug endpoints, dead code in critical paths, or unexplained dependencies.
- Errors are actionable to users and useful to operators without leaking secrets or personal data.
- Database migrations are versioned, repeatable in a clean test database, and have a rollback/recovery strategy.

Release checks: clean install, production build, typecheck, lint, dependency/license review, secret scan, migration apply and migration rollback/recovery rehearsal.

## 2. Security

Baseline: OWASP ASVS Level 1 controls appropriate to the application, with stricter review for personal data and event collaboration.

Required evidence:
- Authentication for all non-public event data.
- Server-side authorization on every read/write; role checks cannot rely on UI visibility.
- PostgreSQL RLS enabled and positively/negatively tested for owner, editor, viewer, unrelated user and anonymous roles.
- No service-role key or privileged database credential in browser bundles or client logs.
- Secure session/cookie configuration, CSRF protection where cookie-authenticated mutations are used, and rate limits on sensitive endpoints.
- Contextual output encoding, input validation, safe SQL, security headers and restrictive content security policy.
- Upload allowlist, size limits, content inspection, malware scanning/quarantine before access, private object storage and signed access.
- Secrets management, dependency vulnerability review, audit trail integrity, backup/restore test and privacy/data-retention controls.
- No cross-tenant access, privilege escalation, forged audit records, or unauthorized consequential actions.

Release checks: negative authorization matrix, RLS tests against a real PostgreSQL/Supabase test project, OWASP-focused API tests, upload abuse tests, dependency and secret scans, backup restore rehearsal. No production release based only on a local-only demo.

## 3. Efficiency and reliability

Required evidence on a documented reference environment and representative seeded dataset:
- Budget and expense arithmetic uses integer minor units or exact decimal arithmetic end-to-end; no binary floating-point financial accumulation.
- Pagination for potentially unbounded event, guest, task, vendor and expense lists.
- Database indexes justified by observed query patterns; no unbounded N+1 query behavior.
- AI calls have explicit timeouts, output/token limits, per-user quotas, bounded retries and graceful non-AI fallback.
- External provider failure does not corrupt or block core manual planning workflows.
- Writes are transactional; retries are idempotent for expense creation and other non-repeatable operations.
- No unbounded memory/file buffering for uploads; bounded request and file sizes.

Initial performance budgets (to be measured, not assumed): non-AI API p95 <= 500 ms at 20 concurrent users on the declared test environment; initial dashboard LCP <= 2.5 s on the declared mobile test profile; CLS <= 0.1. Any deviation requires evidence and an explicit product decision. AI latency is measured separately and must have a visible timeout/fallback.

Release checks: load test, query inspection, memory/upload stress test, concurrent write test, timeout/retry/provider-outage tests and performance report.

## 4. Testing

Required evidence:
- Unit tests for budget allocation, expense arithmetic, date/time handling, schema validation and planning rules.
- Integration tests for every core API and database transaction.
- Authorization tests for each role and cross-tenant negative cases.
- End-to-end tests for all three event types across create, plan, edit, budget, tasks, vendors/quotes and guest workflows.
- Adversarial tests for malformed payloads, oversized uploads, duplicate submissions, concurrency, provider outage and malicious document content.
- Regression tests for every fixed defect.
- Windows 10/11 test run on a supported Node.js version, plus supported browser tests.
- Core business logic coverage >= 90%; overall line coverage >= 80% as a diagnostic, not a substitute for meaningful assertions. Critical authorization and financial invariants require explicit tests regardless of coverage.

Release checks: clean CI run with recorded commit, commands, environment, test counts, failures and artifacts. Flaky tests are defects, not passing tests.

## 5. Accessibility

Target: WCAG 2.2 AA for all MVP workflows.

Required evidence:
- Semantic landmarks, headings, links, buttons, tables and form controls.
- Every form control has a persistent programmatic label and understandable validation/error association.
- Complete keyboard operation, logical focus order, visible focus, no keyboard traps, and focus return after dialogs.
- Dialogs expose correct semantics, initial focus, Escape handling where appropriate, focus containment and focus restoration.
- Dynamic updates/status messages are announced appropriately without excessive announcements.
- Color is not the sole carrier of meaning; text contrast meets WCAG AA; text zoom/reflow and responsive layouts work.
- Calendar, progress indicators, tables and custom widgets have accessible names, roles, states and alternatives.
- Reduced-motion preferences are respected.

Release checks: automated axe/WCAG scan with zero critical/serious findings on core screens, plus manual keyboard-only, screen-reader, zoom/reflow and contrast review. Automated scans alone do not prove conformance.

## 6. Problem statement alignment

All three event types are mandatory: wedding, birthday and community event.

Each type must complete an end-to-end workflow with:
- Event requirements and preferences.
- INR budget with editable categories, deterministic totals and expense tracking.
- Date-aware timeline and editable task checklist.
- Vendor checklist/records and quotation comparison with provenance and explicit verification state.
- Personalized ideas that are clearly labelled as generated suggestions, not facts.
- Guest management where appropriate, with privacy controls.

The application must distinguish estimates, user-entered information, AI suggestions and independently verified facts. It must never fabricate vendor identities, availability, reviews or market quotations. Manual planning must remain available if AI or external services are unavailable.

Release checks: scripted acceptance journeys for wedding, birthday and community events, including no-AI mode and missing-date/missing-price cases.

## Evidence record template

For each release candidate record:
- Commit/build identifier and environment.
- Gate status: PASS / FAIL / NOT TESTED / OUT OF SCOPE.
- Commands and exact test results.
- Defects with severity, reproduction, affected requirement and owner.
- Fix commit and regression evidence.
- Residual risks and explicit release decision.

A gate marked NOT TESTED is not passed. An out-of-scope feature cannot be counted toward problem alignment.
