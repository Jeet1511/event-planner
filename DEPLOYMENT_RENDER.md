# Deployment — Supabase + Render

## Decision

**Supabase Postgres** for persistence, **Render** for the web service, one platform for hosting.

The earlier plan in this file named Render PostgreSQL and excluded Supabase. That changed on
instruction: Supabase is the intended store. The rest of the reasoning is unchanged — this is a
long-lived Node HTTP process with an in-memory proposal queue, an AI concurrency slot and per-client
rate buckets, so it wants one persistent service rather than request-scoped functions.

Persistence talks to Supabase over **PostgREST** (`src/db-store.mjs`) instead of a Postgres driver,
because the project still ships with zero dependencies and no build step.

## What is implemented and verified

Verified against a local fake PostgREST (`npm run verify:prod (scripts/verify-production.mjs)`, 9/9) — the same technique
`test/gemini.test.mjs` uses for the Gemini adapter:

- `NODE_ENV=production` boots **only** when durable persistence *and* a ≥16-character
  `EVENTPILOT_ACCESS_KEY` are both configured; otherwise it exits with a message naming what is
  missing. Non-loopback binding has the same precondition.
- Every `/api` route answers **401** until the key is exchanged for an `HttpOnly`, `SameSite=Strict`,
  7-day session cookie. `Set-Cookie` never contains the key — the cookie is `nonce.HMAC(nonce)`.
- Revoked nonces are remembered (bounded, swept), so signing out actually ends the session instead
  of only deleting the browser copy.
- Key attempts are rate limited to 5/min per client.
- `/api/health` stays reachable without a session for platform probes, and stops reporting
  `eventCount` once the deployment is keyed.
- Writes go to the database: one event created in production mode produced exactly one row.
- **Data survives a full process restart** — the property the JSON file store could never promise on
  Render's ephemeral filesystem.
- Only changed rows are written (per-event digest diffing); a no-op mutation issues no write.
- 96 automated tests, including 10 for the store and 8 for access control.

## What is NOT done, and is not fakeable

1. **No real Supabase project has been contacted.** There are no `SUPABASE_*` credentials on this
   machine, so the schema in `db/migrations/001_events.sql` has never been executed and the RLS
   posture is asserted by reading the SQL, not by a query. Apply it in the Supabase SQL editor, then
   re-run the journey against the live project.
2. **No deployment exists.** There is no Render or Vercel account, token or CLI here. `render.yaml`
   describes a service; it is not proof of one. Do not paste a made-up URL into the submission.
3. **This is one shared workspace, not user authentication.** The access key gates the whole
   deployment; there are no accounts, no per-event membership and no roles. Anyone with the key sees
   every event. That is acceptable for a single-judge demo and unacceptable for a real product —
   `db/migrations/001_events.sql` carries the commented `owner_id` + policy shape for the next step.
4. **Quotation uploads are still on local disk.** They survive a restart on a mounted persistent
   volume; on Render's free ephemeral filesystem they are lost. Object storage is not implemented.
5. **No backup/restore rehearsal, no load testing, no screen-reader audit.**

## Environment contract

| Variable | Required for public deploy | Notes |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` |
| `HOST` | yes | `0.0.0.0` on Render |
| `PORT` | yes | injected by the platform |
| `SUPABASE_REST_URL` | yes | `https://<ref>.supabase.co/rest/v1` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | bypasses RLS — server-side only, never in the bundle or a log |
| `EVENTPILOT_ACCESS_KEY` | yes | ≥16 chars; gates every API route |
| `GROQ_API_KEY` | for live AI | free tier is ~8,000 tokens/min; one plan call is ~1,450 |
| `EVENTPILOT_AI_PROVIDER` | no | `auto` = Groq → Gemini → deterministic templates |

## Release order

1. Create the Supabase project, run `db/migrations/001_events.sql`, confirm `select` from `anon` is
   denied in the SQL editor.
2. Create the Render web service from `render.yaml`, fill the four `sync: false` secrets.
3. Open the live URL, verify the lock screen appears, unlock with the key, create an event,
   **restart the service** and confirm the event is still there.
4. Only then treat the URL as submission material.
