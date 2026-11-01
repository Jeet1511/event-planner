-- EventPilot AI — Supabase Postgres schema, migration 001.
--
-- One table. The application's aggregate is an event document, and every
-- invariant that matters (paise totals, deadline ordering, dependency
-- references, money never below recorded spend) is enforced in
-- src/planning.mjs against the whole event, because that is where those rules
-- already live and are already tested. Splitting tasks, expenses and guests
-- into their own tables would duplicate that logic in SQL without making the
-- rules any stronger — so this schema stores the document and secures it, and
-- leaves the arithmetic to the code that is covered by tests.

create table if not exists public.events (
  id          uuid primary key,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A row may not describe a different event than its key. This is cheap and it
  -- stops a malformed write from silently overwriting another record.
  constraint events_id_matches_document check ( (data ->> 'id')::uuid = id )
);

-- The list endpoint orders by creation date; without this the read is a scan.
create index if not exists events_created_at_idx on public.events (created_at desc);

-- Row Level Security.
--
-- Enabled with NO policy for the anon and authenticated roles. That is the
-- deny-by-default position: a leaked publishable/anon key can read or write
-- nothing. The server talks to PostgREST with the service-role key, which
-- bypasses RLS by design and must never appear in the browser bundle, in a
-- screenshot, or in the submission text.
alter table public.events enable row level security;
revoke all on public.events from anon, authenticated;

-- Optional hardening for a later multi-user build: give every row an owner and
-- let users see only their own. Left commented out because this build has one
-- workspace behind a shared key, and shipping an owner_id column that nothing
-- populates would be decoration, not security.
--
-- alter table public.events add column owner_id uuid not null;
-- create policy events_owner_select on public.events for select using (owner_id = auth.uid());
-- create policy events_owner_write  on public.events for all    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
