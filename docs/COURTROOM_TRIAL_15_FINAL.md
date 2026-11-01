# Trial 15 — Engineering Courtroom Report

## Verdict

**DO NOT RELEASE.** The application remains a local prototype. A fail-closed deployment guard has been added so the current unauthenticated JSON-backed server cannot be accidentally exposed on a network interface or started with `NODE_ENV=production`.

## Six quality gates

| Gate | Verdict | Evidence / gap |
|---|---|---|
| Code Quality | PARTIAL | 20 automated tests and syntax checks pass. Browser application remains densely coupled; clean production build, lint/typecheck, dependency/license report and modular refactor remain. |
| Security | FAIL / BLOCKED | No runtime authentication or tenant authorization; JSON persistence remains active; migrations not applied; no real RLS tests. Guard prevents accidental public exposure but does not replace security controls. |
| Efficiency | NOT TESTED | No load profile, p95 measurements, database query plan, multi-process concurrency or memory stress evidence. |
| Testing | PARTIAL | 20/20 Node tests pass. No Windows, real Ollama, Supabase, browser E2E, accessibility automation, load or restore test. |
| Accessibility | NOT VERIFIED | Some semantic labels and keyboard behaviors exist, but no WCAG 2.2 AA manual/automated audit. |
| Problem Statement Alignment | PARTIAL | Wedding, birthday and community planning templates and structured AI proposal path exist. Persistent authenticated workspaces and full secure workflows are not delivered. |

## New defect EP-015 — Unsafe deployment configuration

**Severity:** Critical  
**Original condition:** `HOST` could be set to `0.0.0.0` despite unauthenticated API routes and shared JSON persistence.  
**Fix:** `src/deployment.mjs` now rejects non-loopback binding and production startup.  
**Regression evidence:** tests cover loopback allowlist, non-loopback rejection and production rejection; all pass. Manual process checks confirmed both unsafe startup modes exit with status 1.  
**Residual:** This only contains the prototype. It does not implement authentication or make deployment possible.

## Gemini API diagnostic

An actual HTTPS request to the Gemini API was attempted using the user-provided key. The runtime returned `TypeError: fetch failed` before an HTTP response was available. Therefore key validity, model access, quota and generation behavior remain **unknown**. No key was written to the repository or build artifacts. The product specification's default remains local Ollama; no paid provider has been introduced.

## Architecture direction

Keep the runtime lean: Node built-ins for the HTTP boundary and domain utilities, Render PostgreSQL for durable multi-tenant data, and a small provider adapter for local inference. Avoid adding frameworks or dependencies unless they solve a concrete requirement. Split by domain boundary (auth, events, budgets, tasks, vendors, guests, AI, storage) rather than compressing everything into fewer files; smaller line count is not the same as maintainability.

## Required external prerequisites

A Render PostgreSQL instance and an application-managed authentication/authorization layer are required to validate the hosted data plane. The environment also needs a reachable Ollama runtime/model for local GenAI acceptance. These are not available in this execution environment, so their integration cannot honestly be marked complete.
