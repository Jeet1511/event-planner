# EventPilot AI — offline MVP prototype

Windows-compatible, dependency-free local prototype for planning weddings, birthdays and community events in India. Features include INR budgets and expenses, editable budget categories, tasks, manual vendor records, quotation comparison, guest RSVPs and structured local AI planning proposals through Ollama.

> **Important:** This is a local demonstration, not the approved production architecture. It has no authentication, multi-user authorization, hosted database or production-grade document malware scanning. It binds to `127.0.0.1` and stores event/guest data as plaintext JSON. Do not expose it to a network or enter real guest contact details, sensitive contracts or confidential information. Render is the intended hosting platform, but this build is not yet deployable: authentication and PostgreSQL persistence must be implemented first.

## Requirements and run

- Windows 10/11
- Node.js 20.9 or newer (Node 22 recommended)
- No npm packages required

In PowerShell, from the project directory:

```powershell
npm test
npm run check
npm start
```

Open http://127.0.0.1:3000. Stop with Ctrl+C. Alternatively run `.\run-windows.ps1` from PowerShell.

## Free local AI (optional)

The application works offline using deterministic planning templates. For structured plan proposals without a paid API:

1. Install Ollama for Windows: https://ollama.com/download/windows
2. Run `ollama pull qwen2.5:3b`
3. In the same PowerShell session:

```powershell
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:OLLAMA_MODEL = "qwen2.5:3b"
# Keep OLLAMA_ALLOW_REMOTE unset/false for local-only inference.
npm start
```

The model download needs disk space and internet access; inference runs locally after download. Remote Ollama endpoints are blocked by default; only set `OLLAMA_ALLOW_REMOTE=true` when you deliberately trust a remote endpoint with event data. The app checks `/api/tags` to distinguish a ready model from a missing model or unavailable runtime. It requests structured JSON for tasks, deadline suggestions, budget category shares, ideas, vendor checklists and risks, then validates the result. A generated proposal is shown for review before the user confirms saving it. AI output remains a suggestion: it cannot establish vendor identity, prices, reviews or availability. Financial totals are reconciled in deterministic code.

## Feature status

- [x] Wedding, birthday and community templates
- [x] INR budget allocation using integer paise arithmetic
- [x] Expense recording and budget summaries
- [x] Task checklist with dates, priorities and completion state
- [x] Manual vendor records and quotation comparison
- [x] Optional PDF/JPEG/PNG quotation attachment (5 MB cap, file signature check; no malware scan)
- [x] Guest list and RSVP status
- [x] Structured local Ollama planning proposals and deterministic fallback
- [x] Runtime/model health distinction and proposal provenance
- [x] Editable budget category names and allocations
- [x] Review-and-confirm step before saving a newly generated plan
- [x] Responsive dashboard
- [x] Node built-in unit and HTTP workflow tests
- [ ] Authentication and multi-user roles in running prototype (critical blocker)
- [ ] Render PostgreSQL integration, application authentication and tenant authorization
- [ ] Secure cloud document storage and malware scanning
- [ ] Email invitations/reminders
- [ ] Live vendor discovery or booking
- [ ] Calendar drag/drop and notifications
- [ ] Persistent event-scoped AI chat and AI action-diff approval workflow

## Deployment target: Render

Render is the selected hosting platform. See [`DEPLOYMENT_RENDER.md`](DEPLOYMENT_RENDER.md) for the target architecture and release blockers. Do not deploy this build publicly: it deliberately refuses production startup and non-loopback binding until authentication, tenant authorization and PostgreSQL persistence are implemented.

## Repository reuse decision

GitHub and npm registry DNS were unavailable in the build environment. No third-party repository was cloned and no external package was installed. The local prototype uses Node built-ins so it remains runnable offline; it does not claim that a starter repository was integrated.

For the next online-enabled integration stage, evaluate:

- Next.js: https://github.com/vercel/next.js
- shadcn/ui (MIT): https://github.com/shadcn-ui/ui
- FullCalendar Standard (MIT; Premium scheduler features need a separate license): https://github.com/fullcalendar/fullcalendar

The current implementation remains a dependency-free local prototype while the Render production data plane is being designed.

## Security and data notes

- Local JSON persistence is demonstration-only, not concurrency-safe and not encrypted.
- Server binds to loopback (`127.0.0.1`). Do not set `HOST=0.0.0.0`.
- Quotation files are stored under `data/private-uploads`, not served as static files. No malware scanning is performed.
- Vendor and quotation details are user-entered and unverified. No live vendor search occurs.
- Render PostgreSQL is the target database. No production database connection or schema migration is implemented in this build.
- No legal compliance determination is made; obtain an India-specific privacy and consumer-law review before public launch.

## Trial 15 implementation status

See [`BUILD_STATUS.md`](BUILD_STATUS.md) and [`docs/TRIAL_15_IMPLEMENTATION_REPORT.md`](docs/TRIAL_15_IMPLEMENTATION_REPORT.md) for exact implemented items, commands, test evidence and unresolved release blockers. The current build is **not production-ready**: runtime authentication/tenant isolation and PostgreSQL persistence are not implemented. Keep the server bound to `127.0.0.1`; do not expose it to a network or enter real guest contacts or confidential contracts.

## Tests

```powershell
npm test
npm run check
```

Tests cover budget arithmetic, event validation, all three templates, expense-category validation and a local HTTP workflow. They do not prove production security, database authorization correctness, Windows runtime compatibility or AI quality.
