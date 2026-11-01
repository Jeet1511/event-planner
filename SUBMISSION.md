# Hackathon submission pack — EventPilot AI

Prepared so the form can be filled in one sitting. **Nothing here has been submitted**: the
Hack2Skill dashboard returns 404 for an unauthenticated session and this browser profile is not
logged in, so submission is blocked at your account.

## Read this before you submit

Two things need your decision, and I could not resolve either without inventing something:

1. **Which challenge.** The event page lists four coding challenges and **all four are marked
   Concluded**: 01 Fan Engagement & Experience (live sport), 02 Election Process Education,
   03 Carbon Footprint Awareness Platform, 04 Smart Stadiums & Tournament Operations (FIFA 2026).
   This project is an **event-planning assistant for Indian weddings, birthdays and community
   events** — it matches none of those four. Either you are registered against a challenge that is
   not on that page, or the brief you gave me came from elsewhere. Submitting this to Challenge 04
   would be a problem-statement mismatch that judges will see immediately, so I did not draft copy
   that pretends otherwise. Confirm the target before submitting.
2. **A live URL.** The submission requires "a live preview of your app". There is no deployment and
   no Render/Vercel/Supabase credential on this machine. Follow `DEPLOYMENT_RENDER.md` → Release
   order; it is about 20 minutes once the accounts exist.

Submission requires two parts per the event page: **Technical** (code + live preview) and
**Narrative** (a technical blog post and a LinkedIn post). Both drafts are below.

## Field-by-field

| Field | Value |
| --- | --- |
| Project name | EventPilot AI — plan an event by talking it through |
| Repo | https://github.com/Jeet1511/event-planner |
| Live URL | _fill after deploying_ |
| One-liner | A GenAI event planner for Indian weddings, birthdays and community events that turns free text into a budget in paise, a dependency-aware timeline, and vendor lead times — and re-plans when circumstances change, one approved diff at a time. |
| Tech stack | Node.js (built-ins only: `node:http`, `node:fs`, `node:zlib`, `node:crypto`, `node:test`), vanilla ES-module browser client, no framework, no build step, zero runtime dependencies; Groq (`openai/gpt-oss-20b`) with a Gemini adapter and a deterministic template fallback; Supabase Postgres over PostgREST for durable persistence |
| Category / difficulty | Advanced (AI + deterministic engine + approval-gated mutations) |

## Description (paste-ready)

> **The problem.** Planning a wedding, a birthday or a community event in India means holding a
> budget in rupees, a countdown of deadlines, vendor lead times and a moving set of requirements in
> your head at the same time — while every change ("the photographer cancelled", "we can stretch to
> 60 thousand") ripples through all of it. Generic to-do apps do the arithmetic in prose and get it
> wrong; chatbots invent vendor names and prices.
>
> **The approach.** The model is never the accountant. EventPilot AI asks the LLM only for
> *structure* — a plan proposal, an action diff, extracted details from a sentence — and every
> number, date and dependency is computed by deterministic code in integer paise, then validated
> against the real stored records. Consequential changes are **proposals**: the user sees the exact
> before/after money table and approves or dismisses each one. Nothing lands silently.
>
> **How it works.** You can start talking on the landing page with no event and no form: "birthday
> party for my younger brother, around 30 people, I don't want to spend too much." The planner
> answers in prose, asks the one question that would change the plan most, and accumulates the
> details across turns — "actually make it 45 people and 55 thousand" is handled as a correction,
> not a restart. Whether enough is known to plan is decided by code, not by the model claiming it
> is ready. Once an event exists, the same rail reads its live plan and proposes typed actions
> (`set_budget_allocation`, `add_tasks`, `update_task`, …), each screened against real record ids,
> impact-analysed, and applied only on approval — re-validated against the persisted event
> fingerprint at approve time, so a plan that changed underneath is refused rather than corrupted.
>
> **What makes it distinctive.** Three things hackathon entries usually get wrong: money (it is
> exact, largest-remainder allocation to the paisa, with totals that cannot drift), dates (UTC
> calendar arithmetic with an India "today", overdue clamping and dependency-order repair), and
> fabrication (it will not name a vendor, a phone number, a price or a permit — it speaks in
> categories, criteria and lead times, and says so). AI failure never destroys data: a rate limit or
> a malformed reply returns a 429/503 with the provider's own reason and a retry countdown, and
> writes nothing.
>
> **Engineering.** 96 automated tests (unit, integration, AI-contract, adversarial, performance)
> green under `TZ=UTC` and `TZ=Asia/Kolkata`. Zero dependencies and no build step; the whole client
> is 24 KB Brotli. WCAG-minded: no text under 13 px, contrast measured at ≥4.70:1 per element
> class, 14/14 keyboard stops with a visible focus ring, reduced motion honoured. Security: loopback
> binding and production startup are refused unless durable persistence and a workspace secret are
> both configured; CSP and origin/content-type guards on writes, prompt-injection delimiting with
> escaped markup, guest names and phone numbers excluded from every prompt (aggregates only),
> per-client AI rate limits with a bounded queue, and error text redacted of URLs and keys.
>
> **Honest limits.** One shared workspace, not user accounts. Unapproved proposals are held in
> server memory and expire in 15 minutes. Quotation uploads are on local disk. Gemini has not been
> exercised against the real Google endpoint. Model *taste* is not benchmarked — structure and
> arithmetic are.

## Technical blog post (draft — publish before submitting)

**Title:** The model doesn't do the money: building an AI event planner that can't lie about rupees

Sections, with the real numbers to use:

1. **Why event planning breaks LLM apps.** Budgets are integer arithmetic over paise; deadlines are
   calendar dates with a timezone; a cancelled vendor cascades. A chatbot asked to "cut the budget to
   14 lakh" will happily tell you it did.
2. **The architecture in one paragraph.** Provider adapters behind one contract
   (`{ id, label, model, health(), generate() }`) for Groq/Gemini/Ollama/mock; three structured
   output contracts (plan, intake/consult, assistant turn) each with a validator and exactly one
   recovery pass; typed action diffs screened against real record ids; deterministic engines for
   money, dates and impact.
3. **The bug that made chat "not work" — and what measurement found.** One plan call cost 2,978
   tokens against Groq's free 8,000 TPM; the recovery pass was then refused with 429. Separately,
   Groq answers HTTP 400 "Failed to validate JSON" when `max_tokens` truncates the reply, and the
   retry resent the identical request, so it could never succeed. Fix: derive a compact type
   signature instead of inlining the JSON Schema (1050 → 650 prompt tokens), `reasoning_effort: low`
   (338 → 6 reasoning tokens), right-sized caps, and a truncation-aware retry that *raises the cap*
   instead of repeating itself. Total per call: 2,978 → 1,458 tokens.
4. **A silent data-loss bug found by probing, not by tests.** Approved `update_event guests` wrote a
   number into a field that stores the guest *list*. Two shapes, one name. Fixed with an explicit
   `plannedGuests()` / `guestList()` split, plus a regression test that the list survives.
5. **Approval as an interface, not a checkbox.** Every proposal renders the before/after money table
   computed by the app, so the user is approving arithmetic they can read, not prose they have to
   trust.
6. **The part I did not fake.** No live Supabase project, no deployment, no Gemini endpoint call, no
   screen-reader audit. Listing them as remaining is more useful than a demo video that hides them.
7. **Code.** Repo link, test count, how to run it in one command (`npm start`).

## LinkedIn post (draft)

> Shipped something I actually care about for PromptWars: Virtual — EventPilot AI, an event planner
> for Indian weddings, birthdays and community events.
>
> The rule I built the whole thing around: the model never does the money. It proposes structure;
> deterministic code computes every rupee in integer paise, every deadline as a real calendar date,
> and every change as an approval-gated diff against records that exist. It will not invent a vendor
> name, a phone number or a price — it speaks in categories, criteria and lead times.
>
> Zero dependencies, no build step, 24 KB of client, 96 tests. Node built-ins and one Groq model.
>
> The most useful bug fix was measuring, not guessing: one plan generation was eating 2,978 tokens
> against an 8,000 TPM free tier, so the retry got rate-limited and the assistant quietly stopped
> working. Compact type signature instead of an inlined JSON Schema, low reasoning effort, and a
> retry that raises the output cap when the provider truncated the JSON → 1,458 tokens, and chat
> that answers in under a second.
>
> Repo: https://github.com/Jeet1511/event-planner

## Demo script (2–3 minutes, for the video)

1. Open the landing page. Point at the ledger: real totals from your own workspace, no sample data.
2. Click **Start the conversation** and type, in one sentence: *"Birthday party for my younger
   brother, around 30 people, and I don't want to spend too much."* Let the reply finish — note it
   asks one question instead of showing a form.
3. Answer with *"It's in Pune, about 40 thousand rupees, he likes cricket."* Then
   *"actually make it 45 people and 55 thousand."* — the correction, not a restart.
4. Click **Create my plan** when the draft card offers it. Show the review sheet: strategy, budget
   shares summing to 100%, deadlines counted back from the date, vendor categories with lead times.
5. Save. Show the workspace: budget bars, the dated timeline with dependency notes, the progress ring.
6. Ask: *"The photographer cancelled two weeks before. What should I do?"* Show the proposal card and
   its **Money effect, calculated here** table, then Approve & apply and watch the plan change.
7. Deliberately fail one thing to show honesty: send four messages quickly, let the rate-limit banner
   appear with its countdown, and point out that nothing was written and the plan is unchanged.
8. Close on the tests: `npm test` → 96 passing.

## What I could not prepare for you

- The submission form itself (needs your logged-in session).
- A demo video — I did not record or upload one.
- Blog/LinkedIn hosting — drafts above, publishing is yours.
