# TalentLens AI

- **Documentation verified:** November 10, 2026
- **Production URL:** https://talentlens-ai.duckdns.org
- **GitHub Repository:** https://github.com/Lokaprathap22/TalentLens-Ai

TalentLens AI is a multi-tenant, human-in-the-loop AI recruitment screening and client shortlist platform built for staffing teams. It turns unstructured job descriptions into versioned, weighted scorecards, securely ingests and parses candidate CVs (PDF/DOCX with bounded OCR fallback), produces evidence-verified criteria assessments using a multi-provider AI pipeline (Google Gemini primary with automatic failover to Groq Cloud), masks candidate contact details in client-facing views, enforces candidate consent and deletion governance, and coordinates client hiring decisions and interviews.

---

## 1. Problem Statement & Solution

Staffing agencies managing dozens of recruiters and hundreds of open requisitions face recurring bottlenecks:

- **Manual screening inconsistency:** Screening hundreds of CVs per job description manually leads to slow turnaround and inconsistent criteria evaluation.
- **Unstructured client collaboration:** Sending candidate spreadsheets and raw CV attachments over email scatters client feedback, risks exposing candidate phone numbers/emails prematurely, and leaves no auditable decision trail.
- **Document & AI security risks:** Parsing untrusted PDFs/DOCX uploads exposes servers to zip bombs, compressed object-stream bombs, malware, prompt injection hidden inside resume text, and unsupported AI scoring hallucinations.
- **Privacy & consent compliance:** Candidates require explicit purpose-scoped consent, transparent withdrawal, and verifiable erasure without leaving orphaned objects in storage or pending email queues.

**TalentLens AI addresses these through:**

- **Explainable scorecard assessments:** AI extracts job requirements into an editable, draft-to-approved versioned scorecard (`DRAFT` → `APPROVED` → `ARCHIVED`). Criterion assessments require verbatim quote verification against redacted CV text; incomplete or unverified evaluations produce `overallScore = null` and `NEEDS_REVIEW` rather than opaque numbers or automatic rejections.
- **Bounded, fail-closed document processing:** Uploads are size-capped, magic-byte checked, streamed through ClamAV (`zINSTREAM`), stored under opaque `YYYY-MM/<uuid>.<ext>` keys in private object storage, parsed inside worker threads with bounded inflate streams, `/ObjStm` object-stream inspection, and Poppler/Tesseract image-pixel limits.
- **Human-controlled client workflow:** Submitting a candidate to a client requires an open requisition, approved scorecard, recruiter review of the current CV, and `ACTIVE` candidate consent. Client views strip candidate contact details until hiring/interview coordination warrants progression.
- **Tenant & privacy boundaries:** Organization scoping uses composite primary/foreign keys across PostgreSQL tables, AES-256-GCM encryption for queued email payloads (`email_outbox`), and fail-closed deletion fencing.

---

## 2. User Roles & Primary Journeys

| Role                        | Access Scope                                                                                                                               | Implemented UI & Capabilities                                                                                                                                                                                                                                                                                                                     |
| :-------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`RECRUITER`**             | Full organization workspace (clients, requisitions, scorecards, CV batches, assessments, shortlists, interviews, consent, deletion)        | Multi-page AppShell workspace: `/dashboard`, `/clients`, `/clients/:clientId`, `/requisitions`, `/requisitions/:requisitionId`, `/scorecards`, `/requisitions/:requisitionId/scorecards/:versionId`, `/candidates`, `/requisitions/:requisitionId/candidates`, `/requisitions/:requisitionId/candidates/:candidateId`, `/interviews`, `/settings` |
| **`CLIENT_HIRING_MANAGER`** | Strictly scoped to their `Client` memberships and `CandidateSubmission` records shared with that client (candidate contact details masked) | Client Dashboard (`/dashboard`), Client Shortlist Portal (`/client-portal`), Client Submission Review modal (Shortlist / Reject with mandatory reason / Propose interview), Shared Interviews view (`/interviews`)                                                                                                                                |
| **`DELIVERY_HEAD`**         | Defined in schema (`UserRole.DELIVERY_HEAD`) for future oversight dashboards                                                               | Currently routes to a read-only placeholder notice at `/delivery-overview`; full oversight analytics are deferred                                                                                                                                                                                                                                 |

### Recruiter Journey

1. **Authenticate:** Sign in at `/login` using **Organization**, **Email**, and **Password** (or activate a newly provisioned account at `/activate#token=...` with an Argon2id-hashed password).
2. **Manage Clients & Requisitions:** Create clients (`/clients`), invite client hiring managers into specific client memberships, and create or open job requisitions (`/requisitions`).
3. **Build & Approve Scorecard:** Extract draft scorecard criteria from the job description via AI (`gemini-3.6-flash` primary with automatic Groq `openai/gpt-oss-120b` failover, or edit manually in `/requisitions/:requisitionId/scorecards/:versionId`), assign criterion categories/weights/`MUST_HAVE` flags, and approve the immutable scorecard version.
4. **Intake Resumes (PDF/DOCX):** Upload resume batches (single/multi-file multipart requests up to 50 MB per request, 15 MB per file, 500 files / 1 GB per batch) and trigger batch finalization, or reuse an existing resume version for a requisition.
5. **Track Processing & AI Assessment:** Worker processes queued extraction/OCR and multi-provider AI (`gemini` -> `groq` failover) assessment jobs with PostgreSQL lease locking; recruiters inspect criterion evidence quotes, redaction status, and extraction warnings on `/requisitions/:requisitionId/candidates/:candidateId`.
6. **Consent, Review & Shortlist:** Invite the candidate for requisition-scoped hiring consent, record recruiter review of the current resume (`REVIEWED`), shortlist the candidate, and submit to the client (`SUBMITTED`).
7. **Coordinate Interviews & Deletion:** Respond to client interview proposals (accept/reject/propose alternatives, mark completed) on `/interviews` or candidate detail, trigger candidate deletion requests, or cancel/process deletion governance actions.

### Client Hiring Manager Journey

1. **Invitation & Account Activation:** Receive an activation email containing a `/activate#token=...` hash-fragment link (48-hour SHA-256 token), set a password, and establish a session.
2. **Client Portal Access:** Land on role-scoped `/dashboard` or navigate to `/client-portal` to view only requisitions and candidates submitted to their authorized client memberships.
3. **Review Submissions:** Inspect AI scorecard summaries and evidence snippets inside the review dialog while candidate direct contact info (email/phone) remains masked.
4. **Hiring Decisions & Interviews:** Shortlist the candidate, decline with a mandatory non-empty reason (cannot use prohibited demographic terms), propose an interview slot, or accept/decline recruiter-proposed interview times and record post-interview hiring feedback.

### Candidate Self-Service Journey

1. **Consent Invitation & Confirmation (`/consent`):** Open a tokenized consent link (`#token=...`), inspect the exact captured `noticeText` snapshot and policy version (sent via `POST /api/v1/consent/inspect` so tokens never travel in URL query strings or referrer headers), and submit `Accept` or `Decline`.
2. **Consent Withdrawal (`/consent/withdraw`):** Request a verification link using email/organization context (`POST /api/v1/consent/withdraw/request`) and confirm withdrawal via hash-fragment token (`POST /api/v1/consent/withdraw/confirm`).
3. **Self-Service Data Deletion (`/consent/deletion`):** Request a deletion verification token (`POST /api/v1/consent/deletion/request`) and confirm deletion (`POST /api/v1/consent/deletion/confirm`), triggering atomic DB redaction/purging and removal of private resume objects from S3/disk storage.

---

## 3. Core Features Implemented

- **Multi-Tenant Authentication & CSRF Defense:** Stateful PostgreSQL `Session` table with HttpOnly session cookie, dynamic HMAC-SHA256 CSRF token (`GET /api/v1/auth/csrf` -> `x-csrf-token`), `APP_ORIGIN` same-origin checks, Argon2id (`m=19456, t=2, p=1`), timing-safe dummy-hash login checks, and IP-based `express-rate-limit`.
- **Multi-Provider Explainable AI Pipeline:** Primary Google Gemini (`@google/genai` `3.0.0`: `gemini-3.6-flash` -> bounded fallback `gemini-3.5-flash`) with automatic independent failover (`AI_PROVIDER_ORDER=gemini,groq`) to Groq Cloud (`openai/gpt-oss-120b` via strict JSON Schema structured outputs) across both JD extraction and worker CV scoring. Includes prompt-injection delimiter isolation (`<untrusted_candidate_resume>`), deterministic 1:1 offset-preserving PII redaction (`2026-11-redactor-v2`), quote verification (`EXACT_QUOTE` / normalized offsets), fail-closed content-safety/invalid-input hard stops, and `weighted_criteria_v2` scoring. Operators enabling Groq on non-synthetic recruitment data must enable Zero Data Retention (ZDR) in Groq Console.
- **Hardened PDF & DOCX Document Engine:** `inflateBounded` stream decompression caps, ZIP Local/CD/EOCD integrity validation, PDF `/ObjStm` compressed object-stream expansion, Poppler `pdfinfo` + `pdftoppm` 150 DPI geometry caps (`<= 10` rendered pages, `<= 25M` pixels/page, `<= 75M` aggregate pixels, `<= 50 MB` PNGs), and Tesseract English OCR.
- **Persistent Encrypted Email Outbox:** AES-256-GCM at-rest encryption (`EMAIL_OUTBOX_ENCRYPTION_KEY`, rotation via `EMAIL_OUTBOX_PREVIOUS_KEYS`) with AAD binding (`recordId:idempotencyKey`), HMAC-SHA256 `idempotency_key`, PostgreSQL `SKIP LOCKED` + `clock_timestamp()` leases, retry/permanent-rejection handling, deletion fencing, and post-send ciphertext shredding (`encrypted_payload = NULL`).
- **Automated Backup, Restore & Preflight Tooling:** `scripts/preflight-env.mjs`, `scripts/generate-secrets.mjs`, `deploy.sh`, `scripts/setup-caddy.sh`, and cross-platform `scripts/backup.{sh,ps1}` + `scripts/restore.{sh,ps1}` with mandatory SHA-256 sidecar verification.

---

## 4. Technology Stack & High-Level Architecture

- **Frontend:** React 19 (`react` `^19.2.0`), TypeScript `^5.9.3`, Vite `^8.0.0`, Tailwind CSS `^4.1.17`, React Router `^8.5.1`, Lucide Icons, `@fontsource-variable/inter`.
- **Backend API:** Node.js 24 (`>=24.11.0 <25`), Express `^5.1.0`, Helmet `^8.1.0`, `express-rate-limit` `^8.7.3`, Argon2 `^0.45.2`, Zod `^4.1.12`.
- **Worker & Document/AI Packages:** Custom bounded ZIP/PDF parser, Poppler (`pdfinfo`, `pdftoppm`), Tesseract OCR (`tesseract-ocr` + `eng` traineddata), multi-provider AI engine (`@google/genai` `3.0.0` `gemini-3.6-flash` / `gemini-3.5-flash` primary + Groq Cloud `openai/gpt-oss-120b` OpenAI-compatible strict JSON Schema failover), custom AWS SigV4 S3 client, raw TCP/TLS `SmtpClient`, ClamAV `zINSTREAM` client.
- **Database:** PostgreSQL 17 (`postgres:17-alpine`), Prisma `^7.10.1` (`@prisma/adapter-pg`, `pg` `^8.16.3`, `previewFeatures = ["partialIndexes"]`).
- **Deployment & Proxy:** Docker Compose V2, `nginxinc/nginx-unprivileged:alpine` (`web:8080`, `client_max_body_size 50M`), host-managed Caddy HTTPS reverse proxy on OCI Ubuntu 24.04 (`127.0.0.1:8080`).
- **Testing & QA:** Vitest `^4.x`, Supertest `^7.1.4`, Testing Library (`@testing-library/react`), Playwright (`@playwright/test` `^1.65.0`), ESLint 9, Prettier 3.

```text
Browser (Recruiter / Client / Candidate)
  │ HTTPS (TLS 1.2/1.3)
  ▼
Host Caddy (:80/:443) ──► 127.0.0.1:8080 ──► Nginx Container (web:8080, SPA static assets)
                                               │ proxy_pass /api/ -> api:3000
                                               ▼
                                        Express API (api:3000, single replica)
                                          ├──► ClamAV (clamav:3310, zINSTREAM scan)
                                          ├──► Private Object Storage (OCI S3 / local dev disk)
                                          ├──► Multi-Provider AI Chain: Gemini -> Groq (JD extraction)
                                          └──► PostgreSQL 17 (postgres:5432)
                                                 ▲
                                                 │ SKIP LOCKED jobs & encrypted outbox
                                        Background Worker (worker)
                                          ├──► S3 Storage + Worker-thread PDF/DOCX/OCR (Poppler + Tesseract)
                                          ├──► Multi-Provider AI Chain: Gemini -> Groq (Candidate assessment)
                                          └──► Transactional SMTP Relay (STARTTLS / TLS)
```

---

## 5. Repository Structure

```text
TalentLens-AI/
├── apps/
│   ├── api/                 # Express 5 REST API (/api/v1), RBAC/CSRF middleware, bootstrap CLI
│   ├── web/                 # React 19 + Vite 8 SPA, Nginx config, recruiter/client/consent portals
│   └── worker/              # Async resume parser/OCR worker, AI runner, SMTP outbox dispatcher
├── packages/
│   ├── shared/              # Shared TypeScript contracts & Zod validation schemas
│   ├── database/            # Prisma client adapter wrapper (@talentlens/database)
│   ├── document-processing/ # Bounded DEFLATE/ZIP/PDF/ObjStm parser + Poppler/Tesseract OCR
│   └── assessment-engine/   # PII redactor, Gemini -> Groq failover engine, evidence verifier, weighted scorer
├── prisma/
│   ├── schema.prisma        # 35 models, 36 enums, multi-tenant composite FKs, partial indexes
│   └── migrations/          # 14 versioned SQL migrations
├── scripts/                 # Env preflight, secret gen, deploy helpers, live provider checks, Caddy setup, backup/restore, E2E & QA scripts
├── docs/                    # Technical Design Document, Operator Runbook, DB Integrity, Phase 1 Spec
├── deploy.sh                # Fail-closed OCI production deployment controller
├── deployment.md            # Complete local & OCI deployment, backup/restore, and access guide
├── docker-compose.yml       # Local development PostgreSQL 17 container
├── docker-compose.prod.yml  # Canonical 5-service production Compose topology (+ migration job)
└── docker-compose.prod-test.yml # Isolated E2E stack (Postgres :5433, S3Mock, Mailpit, ClamAV)
```

---

## 6. Local Development Quick Start

Full step-by-step Windows PowerShell and Ubuntu/WSL instructions live in [deployment.md](./deployment.md).

### Prerequisites

- **Node.js** `>=24.11.0 <25` and **npm** `11+`
- **Docker** (Docker Desktop on Windows/macOS, or Docker Engine + Compose V2 on Linux)
- _(Optional for host OCR fallback)_ `tesseract` and Poppler (`pdfinfo`, `pdftoppm`) on `PATH`, plus Chrome/Chromium or Playwright Chromium for browser QA scripts.

### Local Setup

```powershell
# 1. Install all workspace dependencies
npm install

# 2. Create local environment file from template
Copy-Item .env.example .env
```

> [!IMPORTANT]
> `.env.example` ships with **production container defaults** (`NODE_ENV=production`, `API_PORT=3000`, `@postgres:5432`, `STORAGE_DRIVER=s3`, `SCANNER_DRIVER=clamav`). For local host development with `apps/web/vite.config.ts` (which proxies `/api` to `http://localhost:4000`), edit your local `.env` to use:
>
> - `NODE_ENV=development`
> - `API_PORT=4000` (and `PORT=4000`)
> - `APP_ORIGIN=http://localhost:5173`
> - `DATABASE_URL=postgresql://talentlens:talentlens_local_only@localhost:5432/talentlens?schema=public`
> - `STORAGE_DRIVER=local` and `SCANNER_DRIVER=mock` (or run isolated containers via `docker-compose.prod-test.yml`)

```powershell
# 3. Start local PostgreSQL 17
docker compose up -d db

# 4. Generate Prisma client and apply all 14 migrations
npm run db:generate
npx prisma migrate deploy

# 5. Build workspace packages before bootstrapping or running dev
npm run build --workspace @talentlens/shared
npm run build --workspace @talentlens/database
npm run build --workspace @talentlens/document-processing
npm run build --workspace @talentlens/assessment-engine

# 6. Bootstrap your initial recruiter organization and receive a one-time activation link
npm run bootstrap --workspace @talentlens/api -- "Your Organization Name" "recruiter@example.com" --print-activation-link

# 7. Start web (:5173), API (:4000), and worker concurrently
npm run dev
```

Open the printed `/activate#token=...` URL in your browser (at `http://localhost:5173`) to set a password and sign in at `/login`.

---

## 7. Commands, Testing & Validation

| Command                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| :---------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                                               | Build `@talentlens/shared` and start Web, API, and Worker concurrently                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `npm run dev:web` / `dev:api` / `dev:worker`                | Run individual services in watch mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run build`                                             | Build all packages and apps in dependency order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `npm run typecheck`                                         | Run TypeScript typechecks across source and `tsconfig.test.json` projects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm run lint`                                              | Run ESLint across the monorepo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm test`                                                  | Build prerequisite libraries and execute Vitest across all workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `npm run format:check` / `npm run format`                   | Check or apply Prettier formatting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `npm run db:validate` / `db:generate` / `db:migrate:deploy` | Validate Prisma schema, generate client, or deploy migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run generate:secrets` (`-- --write`)                   | Dry-run or write generated `EMAIL_OUTBOX_*` and `POSTGRES_PASSWORD` secrets into `.env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `npm run preflight:env`                                     | Fail-closed validation of `.env` (production settings, AI provider config & secret strength)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run test:gemini`                                       | Opt-in live synthetic check against Google Gemini (`GEMINI_API_KEY`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run test:groq`                                         | Opt-in live synthetic strict `json_schema` check against Groq Cloud (`GROQ_API_KEY`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `npm run diagnose:jd` (`-- --provider=auto\|gemini\|groq`)  | Real end-to-end JD extraction provider diagnostic (zero PII)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `npm run deploy:local` (`-- --dry-run`)                     | Validate local env (fail-closed on prod/remote DB), auto-detect Compose V2/V1, poll DB `pg_isready`, run SHA-256 fingerprint-cached shared builds (`--force` to rebuild), and check migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `npm run deploy:production`                                 | Default safe dry-run & preflight (`--remote-env-file ../.env.candidate` or `-- --ssh-host <user@host> --env-file ../.env.candidate` via `node --` targets remote OCI env files without requiring/reading them locally on Windows); with `-- --execute --confirm-production --ssh-host <user@host> --remote-dir <path>`, executes the 10-stage OCI SSH release pipeline (sanitized tarball + `.sha256`, `docker-compose.oci.yml` auto-reuse, fingerprint idempotency skip/`--force`, remote `preflight-env.mjs --strict-perms` & Compose checks, mandatory custom `.dump` backup with `--skip-backup` prohibited, `:previous` image tagging, `deploy.sh`, HTTPS check, rollback instructions) |
| `node --test scripts/e2e-safety-guard.test.mjs`             | Verify browser E2E safety guardrails against non-isolated targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `node --test scripts/deploy-scripts.test.mjs`               | Run 24 deterministic unit/integration/CLI tests covering `deploy-local`, 10-stage `deploy-production`, remote-only env-file isolation (`node --` & `--remote-env-file`), stale-file clean sync & snapshot rollback, OCI overlay preservation, fingerprint idempotency, mandatory backup, sanitized tarballs, build cache, and zero-dependency dual-provider `preflight-env` rules                                                                                                                                                                                                                                                                                                            |
| `node scripts/visual-qa.mjs`                                | Capture desktop/mobile mock-API screenshots into `artifacts/visual-qa` (or `$TALENTLENS_ARTIFACT_DIR`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### PostgreSQL Integration & Production-Topology E2E Tests

- Integration suites gated on PostgreSQL (`*.integration.test.ts` and `email-dispatcher.test.ts`) run when `TALENTLENS_RUN_PG_INTEGRATION=1` and `TALENTLENS_INTEGRATION_DATABASE_URL` target a disposable test database.
- Full-stack isolated E2E verification uses `docker-compose.prod-test.yml` (isolated Postgres `:5433` `talentlens_scorecard_test`, S3Mock `:9090`, Mailpit `:8025`/`:1025`, ClamAV `:3310`, Nginx `:8080`) with `scripts/run-browser-e2e.mjs`. Safety guards in `scripts/e2e-safety-guard.mjs` fail closed if pointed at production databases, external SMTP hosts, or non-test buckets.

---

## 8. Documentation Map

- **[deployment.md](./deployment.md):** Complete Windows PowerShell & Ubuntu/WSL local setup, authoritative `.env.example` & runtime variable table, OCI Ubuntu 24.04 architecture, actual OCI staging directory (`docker-compose.oci.yml` decision), 15-step release runbook, backup/restore CLI reference, and account bootstrap/access flows.
- **[docs/TECHNICAL_DESIGN_DOCUMENT.md](./docs/TECHNICAL_DESIGN_DOCUMENT.md):** Engineering architecture, Mermaid system and ER diagrams, 35-model schema and 14 migrations, security/privacy invariants, document/OCR/Gemini pipeline details, and all 71 `/api/v1` endpoints.
- **[docs/OPERATOR_RUNBOOK.md](./docs/OPERATOR_RUNBOOK.md):** Operational runbook for secret generation, SMTP outbox delivery, ClamAV `zINSTREAM` scanning, S3 privacy controls, keyring rotation, and single-replica API rate-limiter constraints.
- **[docs/DATABASE_INTEGRITY.md](./docs/DATABASE_INTEGRITY.md):** Relational tenant isolation, composite foreign keys, and extraction/assessment immutability guarantees.
- **[docs/TECHNICAL_SPEC.md](./docs/TECHNICAL_SPEC.md):** Historical Phase 1 product & technical baseline specification.

> [!NOTE]
> **OCI Live Status Note:** Host-specific server overlay `docker-compose.oci.yml` on `/home/ubuntu/talentlens-release-staging-20261110/source` is managed outside Git and must pass `AI_PROVIDER_ORDER` and `GROQ_*` environment variables into `api` and `worker` (plus complete live smoke verification for CV upload/OCR/AI assessment and client portal flows) before Groq failover is claimed active in live OCI production.
