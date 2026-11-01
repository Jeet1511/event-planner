# Render deployment target — implementation plan

## Decision

Render is the selected hosting platform. Supabase is not part of the target architecture.

## Target topology

- Render Web Service: Node.js HTTP application.
- Render PostgreSQL: durable relational application data.
- Private object storage: quotation files and other user uploads (use a dedicated S3-compatible provider or an appropriate managed storage service; do not rely on the web service's ephemeral filesystem).
- AI adapter: Ollama for local development; optional Gemini provider only when configured by the operator. AI must remain non-authoritative and all generated changes require validation and user confirmation.

## Why this build cannot be deployed yet

The current application still reads and writes `data/events.json`, has no runtime authentication, and has no per-event authorization. Render web-service filesystems are ephemeral by default, and multiple instances cannot safely coordinate through a local JSON file. The application also deliberately rejects `NODE_ENV=production` and non-loopback binding. Do not remove that guard just to make deployment start.

## Required implementation sequence

1. Add PostgreSQL schema migrations and a small repository layer; enforce foreign keys, constraints, transactions and indexes.
2. Implement authentication with a maintained password-hashing algorithm (Argon2id or scrypt), secure HttpOnly/Secure/SameSite cookies, CSRF protection for cookie-authenticated mutations, session rotation, logout and password-reset flow.
3. Add event membership and role-based authorization. Every event-scoped API must derive the actor from the verified session and authorize access server-side; never trust a client-supplied owner ID or role.
4. Move uploads to private object storage; validate file signatures and sizes, scan/quarantine files, and issue short-lived authorized download URLs.
5. Add rate limits, security logging without secrets/PII, request timeouts, graceful shutdown, health/readiness checks and database connection management.
6. Add integration tests against disposable PostgreSQL for anonymous, owner, editor, viewer and unrelated-user cases, plus migration rollback/recovery and concurrent writes.
7. Add browser E2E, WCAG 2.2 AA audits, load/concurrency tests, backup/restore rehearsal and Windows checks.
8. Only then add `render.yaml`, configure Render environment variables and deploy a staging service. Promote to production only after all six quality gates pass.

## Required Render configuration (future)

- Runtime: Node.js supported LTS.
- Build command: `npm ci` (after production dependencies are introduced and lockfile is verified).
- Start command: `npm start`.
- Bind host: `0.0.0.0` and use Render's injected `PORT` only after the production guard is replaced by completed controls.
- Database URL: store as a secret environment variable; never commit credentials.
- Migrations: run as a controlled release/pre-deploy step, not automatically on every web process boot.

No Render Blueprint is included yet because it would give the false impression that this unauthenticated JSON-backed prototype is safe to deploy.
