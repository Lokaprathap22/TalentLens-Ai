# TalentLens AI — Project Handoff for a New AI Coding IDE

**Purpose:** Transfer the durable technical and product context from the previous coding-assistant workflow into Google Antigravity. This document is a handoff, not a substitute for inspecting the repository. Some implementation status below comes from prior agent reports and has not yet been independently audited. Always distinguish verified repository facts from reported history and assumptions.

**Local project path previously used:** `C:\Users\revat\Desktop\TalentLens-AI`

**GitHub repository previously used:** `Lokaprathap22/TalentLens-Ai`

**Primary branch previously used:** `main`

**Current milestone:** Independently audit the recent scorecard remediation in read-only mode. Do not start frontend integration until the backend audit is satisfactory.

---

## 1. Product overview

TalentLens AI is a multi-tenant AI-assisted resume screening and client shortlist portal for a staffing/recruitment firm.

The core workflow is intended to be:

1. A recruiter creates and manages a client requisition and supplies a job description (JD).
2. The system extracts job-related requirements from the JD and proposes an editable recruiter scorecard.
3. A recruiter reviews and verifies the requirements and approves a scorecard version. AI extraction must never silently invent criteria or approve its own output.
4. Resumes (PDF/DOCX) are uploaded in batches, parsed, deduplicated, and associated with candidates and requisitions.
5. Candidate assessments score candidates against the approved scorecard. Each criterion score must have traceable supporting evidence from the resume; unsupported claims should remain unverified/unscored, not be fabricated.
6. Recruiters review candidates and explicitly decide whom to submit. AI must never automatically reject candidates.
7. Client hiring managers use a restricted portal to view submitted candidates with contact details masked, then shortlist/reject with a reason or propose an interview.
8. Consent, deletion requests, audit events, and tenant boundaries are enforced throughout the lifecycle.

### Product constraints and exclusions

- Do not add job-board scraping, video interviews, or background checks unless the user explicitly changes scope.
- Human recruiters remain accountable for screening and submission decisions.
- Low-scoring candidates remain searchable; do not silently remove them from consideration.
- Recruiters should open/review the CV before submitting a candidate to a client.
- Use weekly sampling/rank review as a fairness-monitoring concept; do not claim fairness is guaranteed just because demographic fields are excluded from model input.
- Do not use protected demographic attributes in scoring.
- Preserve candidate consent, purpose limitation, deletion workflows, and auditability.
- Enforce client-specific visibility and prevent one client from accessing another client's candidates/submissions.
- Client-facing views must mask candidate contact information unless a separately authorized workflow explicitly permits disclosure.

## 2. User and collaboration preferences

- The user is a 4th-year B.E. Computer Science student at M.S. Ramaiah Institute of Technology, Bengaluru; graduation expected 2027. This background is context only and should not be repeated unnecessarily.
- The user uses Windows, PowerShell, and VS Code. The previous local path is listed above; confirm the actual Antigravity workspace path rather than assuming it.
- The user relies on an AI coding agent to implement work and wants explicit, sequential milestones and technically rigorous explanations.
- Do not skip steps or collapse complex work into vague summaries.
- Preserve existing worktree changes. The user does not want automatic commits or pushes. They prefer to complete an agreed group of milestones, inspect the final diff, and only then decide on a combined commit.
- When producing prompts for the coding agent, make them complete and precise, with scope, constraints, verification, and a final report format.

## 3. Repository architecture and stack (reported; verify in repository)

The repository is an npm-workspaces monorepo. The reported top-level layout is:

```text
apps/
  web/                 # React/Vite frontend application
  api/                 # Express API
  worker/              # asynchronous processing worker
packages/
  shared/              # shared contracts/types/utilities
  database/            # Prisma/database package
prisma/                # Prisma schema, migrations and config
  migrations/
docs/                  # project/architecture/product documentation
.github/               # repository guidance and automation
```

Reported stack:

- Node.js 24.x; npm workspaces.
- TypeScript 5.9.
- React and Vite 8.x.
- Tailwind CSS 4.x.
- Express 5.x.
- Zod 4.x.
- Prisma 7.x, PostgreSQL 17, `@prisma/adapter-pg`, and `pg`.
- Vitest 4.x.
- Argon2 for password hashing.
- `express-rate-limit` for login throttling.
- OpenAI-compatible AI provider integration implemented with `fetch` rather than a provider SDK.

**Important:** Versions above were captured from earlier work and may differ in the current lockfile. `package.json`, workspace package manifests, and lockfile are authoritative.

### Package and API conventions already established

- API app factory: `apps/api/src/app.ts`.
- HTTP server lifecycle: `apps/api/src/server.ts`.
- Runtime env validation: `apps/api/src/config/env.ts`.
- API routes use `/api/v1/...`.
- Database access uses the shared `@talentlens/database` package and a lazy singleton (`getDatabaseClient()` / `disconnectDatabase()`, according to prior implementation).
- Liveness endpoint: `GET /api/v1/health`.
- Readiness endpoint: `GET /api/v1/health/ready`, performing a harmless database readiness check.
- Prisma 7 configuration is at repository root in `prisma.config.ts` (reported). Generated Prisma client output is under `packages/database/src/generated/prisma` (reported and ignored by Git).
- Do not bypass package boundaries or duplicate database clients. Inspect current exports before importing.

## 4. Database foundation (reported committed baseline)

The initial Prisma foundation was reported to contain approximately 27 models and 28 enums, with a first migration at:

`prisma/migrations/20261103165807_init/migration.sql`

The earlier database validation report stated that the migration was applied, the schema was in sync, and foreign-key constraints had been checked. Reconfirm current state with Prisma status only when safe and appropriate; do not run migrations as part of a read-only audit.

Reported domain models include:

- `Organization`, `User`, `Client`, `ClientMembership`, `Session`
- `Requisition`, `ScorecardVersion`, `ScorecardCriterion`
- `Candidate`, `CandidateIdentity`, `CandidateProfile`, `CandidateSkill`
- `ResumeDocument`, `DocumentExtraction`, `AssessmentText`
- `ProcessingBatch`, `ProcessingJob`
- `CandidateAssessment`, `CriterionAssessment`, `EvidenceSnippet`
- `CandidateReview`, `CandidateSubmission`, `ClientDecision`, `PipelineEvent`
- `CandidateConsent`, `DeletionRequest`, `AuditLog`

The schema is reported to use composite tenant-aware constraints and scoped relationships. It does **not** have PostgreSQL row-level security (RLS), according to the earlier audit. Application-level authorization and tenant-scoped repository queries therefore remain essential. Do not infer that database foreign keys alone establish authorization.

### Existing scorecard-related Prisma fields/enums (reported; inspect schema)

`ScorecardVersion` was reported with:

- `organizationId`
- `requisitionId`
- `version`
- `status`
- `weightsJson`
- `approvedById`
- `approvedAt`

`ScorecardCriterion` was reported with:

- `key`, `label`, `category`, `requirementType`, `weight`, `ruleJson`, `active`, `displayOrder`

Reported enums:

- `ScorecardStatus`: `DRAFT`, `APPROVED`, `ARCHIVED`
- `CriterionCategory`: `SKILL`, `EXPERIENCE`, `NOTICE`, `COMPENSATION`, `OTHER_JOB_RELATED`
- `RequirementType`: `MUST_HAVE`, `PREFERRED`

Reported uniqueness: `@@unique([requisitionId, version])` for scorecard version allocation.

**Schema-change rule:** No Prisma schema or migration changes were part of the scorecard remediation. Do not add a migration just to make an implementation convenient. If the data contract cannot be represented safely in the existing JSON fields, stop and propose the smallest additive schema change for approval.

## 5. Authentication and authorization foundations (reported committed)

Authentication/authorization was implemented before the requisition and scorecard modules. Reported behavior:

### Passwords and sessions

- Password hashing uses Argon2id with parameters previously reported as memoryCost 19456 KiB, timeCost 2, parallelism 1, hashLength 32. Confirm actual constants in source.
- Session tokens use 32 random bytes encoded base64url; only a SHA-256 token hash is stored in the database.
- Session lifetime is 8 hours.
- Session revocation is supported.
- The authenticated principal is deliberately minimal: `{ userId, organizationId, role }`.
- Concurrent sessions are supported.
- A dummy Argon2 password hash is used to reduce account-enumeration timing differences when the organization/user is missing. Verify the real login flow in code.

### HTTP auth routes

Reported endpoints:

- `POST /api/v1/auth/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/auth/csrf`

Cookie behavior reported:

- Production cookie name: `__Host-talentlens_session`.
- Development cookie name: `talentlens_session`.
- HttpOnly, Secure in production, SameSite=Lax, Path=/, no Domain, 8-hour lifetime.

CSRF protection is session-bound HMAC-SHA256 plus exact Origin matching against `APP_ORIGIN`. Mutations should keep the repository's CSRF and Origin requirements.

Login rate limiting was reported at 10 attempts per 15 minutes per IP using process-local memory. This is not sufficient as a shared limiter for multiple API instances; a shared store is needed before horizontally scaling. Trust-proxy behavior for deployment was previously not confirmed.

### Roles and client authorization

- Recruiter-only operations use explicit role allowlists; do not broaden role access accidentally.
- `DELIVERY_HEAD` was not implicitly allowed in recruiter-only endpoints.
- Client membership checks were reported to require matching `clientId`, authenticated `userId`, `organizationId`, active membership, role `CLIENT_HIRING_MANAGER`, and active user/client.
- Candidate submission access must be scoped by exact organization/client/submission. Candidate ID alone is never sufficient to authorize client access.
- A prior audit identified a potential time-of-check/time-of-use concern when membership and submission are checked in separate reads. Before sensitive client mutations/decisions, membership and resource authorization should be revalidated in the same transaction.

## 6. Requisition management (reported uncommitted work)

A requisition module was implemented under:

`apps/api/src/modules/requisitions/`

Reported files:

- `requisition.routes.ts`
- `requisition.service.ts`
- `requisition.repository.ts`
- `requisition.schemas.ts`
- `requisition.dto.ts`
- related route/service/repository tests

Reported endpoints:

- `POST /api/v1/requisitions`
- `GET /api/v1/requisitions`
- `GET /api/v1/requisitions/:id`
- `PATCH /api/v1/requisitions/:id`

Reported security behavior:

- Session required and recruiter role required.
- Organization and recruiter identity derive from authenticated principal.
- Creation sets `createdById` and `assignedRecruiterId` from server-side principal.
- Referenced client must be active and in the same organization.
- List/detail/update are scoped by organization and assigned recruiter.
- PATCH is draft-only and uses an atomic `updateMany` predicate to avoid status injection and races.
- Status fields cannot be injected through request bodies.
- Malformed UUIDs return a controlled 400 `invalid_request` response.
- Mutations use CSRF and Origin validation.
- DTOs use explicit safe field selection.

Earlier tests reportedly covered unauthenticated access, client-manager denial, status injection, non-draft update, cross-recruiter/organization access, and malformed IDs. One earlier validation checkpoint reported 84 total tests (82 API + 2 shared) after requisition work; later scorecard tests increased the count. These counts are historical, not expected current counts.

## 7. JD intake and scorecard backend (recent uncommitted work)

The scorecard module is under:

`apps/api/src/modules/scorecards/`

Reported files include:

- `jd-extraction.types.ts`
- `jd-extraction.provider.ts`
- `jd-extraction.provider.test.ts`
- `scorecard.metadata.ts`
- `scorecard.dto.ts`
- `scorecard.schemas.ts`
- `scorecard.repository.ts`
- `scorecard.repository.test.ts`
- `scorecard.service.ts`
- `scorecard.service.test.ts`
- `scorecard.routes.ts`
- `scorecard.routes.test.ts`

Other files previously reported as touched:

- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/src/config/env.ts`
- related env tests and `.env.example`
- database package index/exports
- existing requisition module and its route registration

Reported scorecard routes:

- `POST /api/v1/requisitions/:requisitionId/scorecards/drafts` — create a draft from the saved JD.
- `GET` scorecard version list for a requisition.
- `GET` a scorecard version.
- `PATCH` a draft scorecard.
- `POST` approve a draft.

Verify actual route methods/paths and validation in the repository.

Reported route access:

- Session required, `RECRUITER` role required.
- Requisition access scoped to organization and assigned recruiter.
- Mutations require exact Origin and CSRF.
- AI generation creates a DRAFT only; no automatic approval.

### AI provider configuration

Reported optional variables:

- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`
- `AI_TIMEOUT_MS`

Default base URL was reported as `https://api.openai.com/v1`; timeout default 30 seconds. Provider uses OpenAI-compatible HTTP `fetch`, no provider SDK. Missing API key should fail in a controlled unavailable/not-configured way. Never expose key values or raw sensitive JD content in logs/errors.

### Original scorecard audit findings (must be independently rechecked)

The first independent review of the earlier implementation returned **NOT APPROVED**. It identified:

1. **H1 — Ungrounded AI extraction:** extraction was trusted without verifying each scoreable criterion against the saved JD. Prompt instructions alone (“do not invent”) were not sufficient.
2. **H2 — Destructive criterion editing:** PATCH deleted and recreated all criteria, losing stable IDs/history and risking metadata loss.
3. **H3 — Multiple approved versions:** approval did not archive a previous approved scorecard.
4. **H4 — Version concurrency:** serializable generation/version allocation lacked bounded handling for known Prisma transaction conflicts/unique-version races.
5. **Metadata contract:** `weightsJson` was an overly permissive/untyped JSON bag. Extraction metadata, scoring config, units, source quotes, confidence, and review state needed a versioned validated contract.
6. **Approval completeness:** approval needed to validate all active criteria's source evidence and recruiter review, in addition to weights and required-criterion rules.
7. **Provider hardening:** URL protocol validation and more failure-path tests were needed.
8. **Test gaps:** timeout/non-OK/malformed provider output, protected attributes, evidence persistence, unit handling, partial-edit preservation, foreign criterion IDs, approval lifecycle, concurrent operations, tenant/CSRF boundaries, and live PostgreSQL transaction behavior needed attention.

### Remediation subsequently reported by Copilot (NOT YET INDEPENDENTLY VERIFIED)

The latest Copilot completion report said it implemented:

- Evidence-backed JD extraction with server-verified quotes and server-computed original JD offsets.
- Evidence states: `PENDING_RECRUITER_REVIEW`, `VERIFIED`, `UNVERIFIED`, `REJECTED`.
- Protected-attribute criteria excluded and surfaced as warnings.
- Stable-ID partial criterion updates; omitted criteria preserved; explicit deactivation retains IDs; foreign criterion protection.
- Versioned extraction/scoring metadata contracts validated with Zod.
- PostgreSQL requisition row locking and bounded retries for recognized Prisma concurrency conflicts.
- Approval requiring verified active criteria and archiving previous approved versions.
- HTTPS provider URL validation and sanitized timeout/configuration handling.

The report stated:

- Full build passed.
- Full typecheck including test typecheck passed.
- Full tests: 104 passed.
- Full lint passed.
- Formatting check passed.
- `git diff --check` passed.

The report also explicitly stated that **no live PostgreSQL concurrency integration test was available**, and mocked tests do not independently prove database serialization behavior.

Treat all items in this subsection as _agent-reported_ until the new IDE independently inspects implementation and tests. Do not cite this report as proof of correctness.

## 8. Git history and current working tree (historical snapshot; inspect before action)

The following commits were reported on `main`:

- `0f1cb45 chore: initialize TalentLens AI project documentation`
- `c51a6a7 chore: initialize full-stack monorepo foundation`
- `d8220e5 feat(database): add Prisma database foundation`
- `e2db328 feat(api): add database readiness and auth foundation`
- `e61bafa feat(api): implement authentication and authorization`

The last pushed commit reported was `e61bafa` (November 4, 2026 in the user's local timeline).

At the latest Copilot checkpoint, requisition work and scorecard remediation were uncommitted. The report said no files were staged, committed, pushed, reset, or discarded. Modified tracked files included `.env.example`, API app/server/config/env wiring and database exports; requisition and scorecard directories were untracked at an earlier checkpoint. Exact final status may differ and MUST be inspected with `git status`.

**Do not assume any branch, commit hash, tracked/untracked state, or diff is still current.** Git status and the actual working tree are authoritative.

## 9. Validation workflow

Previous repo commands included (check `package.json` scripts before running):

```powershell
npm run build
npm run typecheck
npm run lint
npm test -- --run
npm run format:check
git diff --check
```

API-targeted commands previously used:

```powershell
npm run typecheck --workspace @talentlens/api
npm test --workspace @talentlens/api -- --run
```

A prior race was observed when full typecheck ran while Prisma client generation was happening. Run commands sequentially, not concurrently. Do not run database migrations during audit. Distinguish unit/mocked tests from real PostgreSQL integration tests.

## 10. Immediate next task: independent read-only scorecard audit

The user intends to paste a separate, detailed **INDEPENDENT SCORECARD REMEDIATION AUDIT** prompt from the previous conversation after the project handoff is loaded. That prompt requires read-only inspection and prohibits all file and Git modifications.

The audit must trace, not merely name-check:

- JD evidence quote verification and server-computed offsets.
- The actual recruiter verification state transition and its authorization.
- Protected attribute handling through every provider/schema/service/storage path.
- Stable-ID partial edits and preservation of provenance.
- Draft/approved/archived lifecycle and immutability.
- Atomic archival of prior approved versions.
- PostgreSQL transaction/row-lock correctness and bounded retry classification.
- Typed metadata validation and original-unit/source preservation.
- Provider URL, timeout, malformed response, and sanitized error handling.
- Tenant isolation and CSRF/Origin protection across each route.
- Test quality and the absence/presence of live PostgreSQL concurrency tests.
- Git state and scope of all uncommitted changes.

Expected audit verdict must be one of:

- `APPROVED`
- `APPROVED WITH LIMITATIONS`
- `NOT APPROVED`

Findings must be classified by severity with exact file paths and current line numbers. Do not modify code while performing this audit. Do not start frontend integration unless no unresolved high-severity issue remains and the user agrees to proceed.

## 11. Future planned product milestones (not authorization to implement now)

These are broad product areas, not a committed sequence. Confirm current implementation first and ask/plan one milestone at a time:

1. Complete secure JD intake and recruiter-approved scorecard lifecycle.
2. Resume upload, storage, parsing, duplicate detection, and batch/job processing.
3. Evidence-backed candidate assessment against an approved scorecard.
4. Recruiter candidate review, search, and submission workflow.
5. Client portal with masked personal contact fields and strict client-specific access.
6. Client decisions, interview proposals, reasons, and pipeline events.
7. Consent, retention, deletion, auditability, and privacy/fairness review.
8. Frontend flows and end-to-end integration after corresponding backend contracts are stable.
9. Deployment readiness: shared rate-limit storage, trust-proxy configuration, secrets management, observability, backups, migrations, and production security review.

Do not leap ahead to these milestones while the scorecard audit is still pending.

---

## 12. Critical source-of-truth hierarchy

When sources disagree, use this order:

1. Actual current source code and tests.
2. Actual Prisma schema, checked-in migrations, package manifests, and lockfile.
3. Current Git status and history.
4. Existing repository instructions and technical documentation.
5. This handoff's historical notes.
6. Prior AI-agent summaries or assumptions.

Always call out discrepancies. Do not silently reconcile them or modify architecture based only on this document.
