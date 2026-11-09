# TalentLens AI — Deployment, Environment & Operations Guide

- **Documentation verified:** November 10, 2026
- **Production URL:** https://talentlens-ai.duckdns.org
- **GitHub Repository:** https://github.com/Lokaprathap22/TalentLens-Ai
- **Audited Release Archive:** `TalentLens-AI-FINAL-RELEASE-AUDIT.zip` (`SHA-256: 45bda13bc6b4a6d1a037084320786771b2382f2cebfe7562b1b778fcedee31f2`)

> [!IMPORTANT]
> **Production Verification Honest Status (November 10, 2026)**
>
> In OCI Ubuntu 24.04 production, all 14 Prisma migrations are applied, all five runtime containers (`web`, `api`, `worker`, `postgres`, `clamav`) are healthy, host Caddy HTTPS is active, `GET /` returns HTTP 200, `GET /api/v1/health/ready` returns `{"status":"ready","database":"connected"}`, and existing recruiter login, dashboard access, and preserved tenant/client/requisition data have been verified.
>
> End-to-end live production smoke tests for **resume upload/OCR/AI assessment** and the **complete client hiring-manager portal workflow** remain **pending** and are documented as such until executed.

This guide separates **local development setup** from **OCI production deployment and disaster recovery** so host developer workstations and the production VM never share unsafe defaults. Operational background controls (ClamAV streaming internals, S3 privacy controls, keyring rotation, and single-replica API rate limiting) are also covered in [docs/OPERATOR_RUNBOOK.md](./docs/OPERATOR_RUNBOOK.md).

---

## A. Local Development Setup

Local development runs Web (`vite` on `:5173`), API (`apps/api` on `:4000`), and Worker (`apps/worker`) natively via Node.js while PostgreSQL 17 runs in Docker via [docker-compose.yml](./docker-compose.yml). Because [apps/web/vite.config.ts](./apps/web/vite.config.ts) proxies `/api` to `http://localhost:4000`, your local `.env` must override the production container defaults from `.env.example`.

### 1. Prerequisites

#### Windows 11 / PowerShell 5.1+ or 7+

- **Node.js:** `>=24.11.0 <25` (as pinned in [package.json](./package.json) `engines.node`) and **npm** `11+`.
- **Docker Desktop:** Running Docker Engine with Docker Compose V2 (`docker compose version`).
- **Git:** Standard Git CLI for Windows.
- **Optional (only if testing OCR locally outside Docker):** Install Tesseract OCR (`tesseract` + `eng` language data) and Poppler (`pdfinfo`, `pdftoppm`) on `PATH`, or configure `TESSERACT_PATH`, `PDFINFO_PATH`, and `PDFTOPPM_PATH`. Install Google Chrome/Edge or Playwright Chromium (`npx playwright install chromium`) only if running browser QA scripts locally.

#### Ubuntu 24.04 / WSL2

- **Node.js `24.x`** (`>=24.11.0 <25`) and **npm `11+`**.
- **Docker Engine + Compose V2 plugin** (`docker compose version`).
- **Build tools (if compiling native deps such as `argon2`):** `build-essential`, `python3`.
- **Optional local OCR binaries:** `sudo apt-get install -y tesseract-ocr tesseract-ocr-eng poppler-utils`.

### 2. Clone and Install Dependencies

```bash
git clone https://github.com/Lokaprathap22/TalentLens-Ai.git
cd TalentLens-Ai
npm install
```

### 3. Configure Local `.env`

Copy `.env.example` into a git-ignored `.env` at the repository root:

- **Windows PowerShell:**

  ```powershell
  Copy-Item .env.example .env
  ```

- **Ubuntu / WSL / Git Bash:**

  ```bash
  cp .env.example .env
  ```

`.env.example` defaults to **production container values** (`NODE_ENV=production`, `PORT=3000`, `API_PORT=3000`, host `postgres:5432`, `STORAGE_DRIVER=s3`, `SCANNER_DRIVER=clamav`). For **host-based local development**, edit `.env` to use local settings:

```dotenv
NODE_ENV=development
PORT=4000
API_PORT=4000
WEB_PORT=8080
APP_ORIGIN=http://localhost:5173
TRUSTED_PROXY_IPS=127.0.0.1

POSTGRES_USER=talentlens
POSTGRES_PASSWORD=talentlens_local_only
POSTGRES_DB=talentlens
DATABASE_URL=postgresql://talentlens:talentlens_local_only@localhost:5432/talentlens?schema=public

STORAGE_DRIVER=local
ALLOW_LOCAL_STORAGE_IN_PRODUCTION=false
RESUME_STORAGE_ROOT=./storage/resumes

SCANNER_DRIVER=mock
SCANNER_FAIL_CLOSED=true

# Set real Gemini key when exercising live JD extraction or CV AI scoring;
# leave empty only for UI/API flows not calling Gemini.
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
GEMINI_TIMEOUT_MS=30000
ASSESSMENT_PROVIDER=gemini

CONSENT_APPROVED_POLICY_VERSIONS=2026-11-v1
EMAIL_FROM=no-reply@talentlens.ai
```

> [!NOTE]
> Under `NODE_ENV=development` (and `test`), the API and worker email modules automatically supply built-in development fallback keys if `EMAIL_OUTBOX_ENCRYPTION_KEY` and `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` are omitted, whereas `NODE_ENV=production` or `staging` fails closed if they are missing. In development, emails fail/skip cleanly if `SMTP_HOST` is omitted or can be captured with Mailpit in Docker.

### 4. Start Local PostgreSQL and Apply Migrations

From the repository root, start the `db` service defined in [docker-compose.yml](./docker-compose.yml) (bound strictly to `127.0.0.1:5432`):

```bash
docker compose up -d db
docker compose ps
```

Wait until PostgreSQL reports `healthy`, then generate the Prisma Client and apply all 14 versioned SQL migrations:

```bash
npm run db:generate
npm run db:migrate:deploy
```

### 5. Build Workspace Libraries Before Starting Apps

Because workspace packages emit compiled TypeScript outputs to `dist/` imported by `apps/api`, `apps/worker`, and CLI scripts:

```bash
npm run build --workspace @talentlens/shared
npm run build --workspace @talentlens/document-processing
npm run build --workspace @talentlens/database
npm run build --workspace @talentlens/assessment-engine
```

_(Alternatively, run a full monorepo build once via `npm run build`.)_

### 6. Bootstrap Initial Local Organization and Recruiter

Provision an initial organization and invited recruiter, printing the one-time activation link:

```bash
npm run bootstrap --workspace @talentlens/api -- "Local Dev Organization" "recruiter@local.test" --print-activation-link
```

Keep this terminal URL handy; once the web and API dev servers start, open the printed `http://localhost:5173/activate#token=...` link in your browser to set your password.

### 7. Start Web, API, and Worker

Start all three services concurrently in one terminal (`npm run dev` builds `@talentlens/shared` first and launches Vite, Express API with `tsx watch`, and Worker with `tsx watch`):

```bash
npm run dev
```

Or launch each in its own terminal for clearer log separation:

```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

Local URLs:

- **Frontend SPA:** `http://localhost:5173`
- **API Readiness Probe (direct):** `http://localhost:4000/api/v1/health/ready`
- **API Readiness Probe (via Vite `/api` proxy):** `http://localhost:5173/api/v1/health/ready`

### 8. Optional Local Production-Topology E2E Stack

To run S3, ClamAV, Mailpit, Nginx, and API/Worker together locally in containers without affecting local development:

```bash
docker compose -f docker-compose.prod-test.yml up -d --build
```

This isolated stack binds PostgreSQL to `127.0.0.1:5433` (`talentlens_scorecard_test`), S3Mock to `127.0.0.1:9090`, Mailpit UI/API to `127.0.0.1:8025` (SMTP `1025`), ClamAV to `127.0.0.1:3310`, API to `127.0.0.1:3000`, and Nginx Web to `127.0.0.1:8080`.

### 9. Verification Commands (Lint, Typecheck, Tests, Build)

All workspace validation commands defined in [package.json](./package.json):

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run format:check
node --test scripts/e2e-safety-guard.test.mjs
```

> [!TIP]
> Avoid running `npm run build`, `npm run typecheck`, and `npm test` concurrently against the same working tree because `packages/*` share `dist/` artifacts. Run them sequentially.

PostgreSQL integration tests (`*.integration.test.ts`, `email-dispatcher.test.ts`) are opt-in and only execute against a disposable database when explicitly enabled:

- **PowerShell:**
  ```powershell
  $env:TALENTLENS_RUN_PG_INTEGRATION = "1"
  $env:TALENTLENS_INTEGRATION_DATABASE_URL = "postgresql://talentlens:talentlens_local_only@127.0.0.1:5433/talentlens_scorecard_test"
  npm run test --workspace @talentlens/api
  ```
- **Bash:**
  ```bash
  TALENTLENS_RUN_PG_INTEGRATION=1 \
  TALENTLENS_INTEGRATION_DATABASE_URL="postgresql://talentlens:talentlens_local_only@127.0.0.1:5433/talentlens_scorecard_test" \
  npm run test --workspace @talentlens/api
  ```

---

## B. Environment Variable Reference

Never commit `.env`, `.env.candidate`, backup files, or real secret values to Git. Generate high-entropy cryptographic keys for `EMAIL_OUTBOX_ENCRYPTION_KEY`, `EMAIL_OUTBOX_IDEMPOTENCY_SECRET`, and `POSTGRES_PASSWORD` with:

```bash
npm run generate:secrets -- --write
```

### 1. Canonical `.env.example` Variables (37 Variables)

#### Application Runtime & Networking

| Variable Name       | Purpose                                                                              | Required / Optional      | Example Placeholder / Safe Default         | Consuming Services                                                                        | Security Notes                                                                                              |
| :------------------ | :----------------------------------------------------------------------------------- | :----------------------- | :----------------------------------------- | :---------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`          | Execution mode governing fail-closed production checks                               | Required                 | `production` (prod), `development` (local) | `api`, `worker`, `preflight-env.mjs`                                                      | Must be `production` in live deployment; `fake` AI and local storage are blocked when `production`.         |
| `PORT`              | HTTP port bound by API server when `API_PORT` is unset                               | Optional                 | `3000` (prod), `4000` (local Vite proxy)   | `api`, `env.ts`                                                                           | Normalized alongside `API_PORT` inside `parseEnvironment`.                                                  |
| `WEB_PORT`          | Host loopback port published by the `web` Nginx container                            | Optional                 | `8080`                                     | `docker-compose.prod.yml`, `deploy.sh`                                                    | Bound to `127.0.0.1` only; Caddy handles public `80`/`443`.                                                 |
| `API_PORT`          | Express API listening port                                                           | Required                 | `3000` (prod container), `4000` (local)    | `api`, `preflight-env.mjs`                                                                | Must stay inside Docker `internal` network (`expose: 3000`, never public).                                  |
| `APP_ORIGIN`        | Public origin for CSRF origin checks and activation/consent links                    | Required in prod/staging | `https://talentlens.yourdomain.com`        | `api` (`origin-protection.ts`, `auth`, `consent`, `email`), `deploy.sh`, `setup-caddy.sh` | Exact origin only (`https://<host>`), no trailing slash or path.                                            |
| `TRUSTED_PROXY_IPS` | Comma-separated proxy IPs/CIDRs trusted for client IP extraction (`X-Forwarded-For`) | Required in prod         | `172.28.0.10,172.28.0.1,127.0.0.1`         | `api` (`app.ts` proxy evaluator), `preflight-env.mjs`                                     | Required non-empty in production; match Docker bridge/Caddy hops so `express-rate-limit` cannot be spoofed. |

#### PostgreSQL 17 Database

| Variable Name       | Purpose                                                          | Required / Optional | Example Placeholder / Safe Default                                      | Consuming Services                                             | Security Notes                                                                         |
| :------------------ | :--------------------------------------------------------------- | :------------------ | :---------------------------------------------------------------------- | :------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| `POSTGRES_USER`     | PostgreSQL superuser/application role name                       | Required            | `talentlens`                                                            | `postgres`, `deploy.sh`, `backup.{sh,ps1}`, `restore.{sh,ps1}` | Validated against `^[A-Za-z_][A-Za-z0-9_-]*$` in backup/restore scripts.               |
| `POSTGRES_PASSWORD` | PostgreSQL password used to initialize the database volume       | Required            | _(generate via `npm run generate:secrets`)_                             | `postgres`, `preflight-env.mjs`                                | Minimum 16 chars in preflight; must match password in `DATABASE_URL`.                  |
| `POSTGRES_DB`       | PostgreSQL database name                                         | Required            | `talentlens`                                                            | `postgres`, `deploy.sh`, `backup.{sh,ps1}`                     | Kept internal to Docker network in production.                                         |
| `DATABASE_URL`      | Full PostgreSQL connection string for Prisma Client & migrations | Required            | `postgresql://talentlens:<pass>@postgres:5432/talentlens?schema=public` | `api`, `worker`, `migration`, `database`, `prisma.config.ts`   | Use host `postgres` inside Compose, `localhost` for host dev; keep credentials secret. |

#### Google Gemini AI Engine

| Variable Name         | Purpose                                                           | Required / Optional             | Example Placeholder / Safe Default | Consuming Services                   | Security Notes                                                               |
| :-------------------- | :---------------------------------------------------------------- | :------------------------------ | :--------------------------------- | :----------------------------------- | :--------------------------------------------------------------------------- |
| `GEMINI_API_KEY`      | Google AI Studio API key for JD extraction & candidate assessment | Required in prod                | `<gemini-api-key>`                 | `api`, `worker`, `assessment-engine` | Never expose to browser or logs; required when `ASSESSMENT_PROVIDER=gemini`. |
| `GEMINI_MODEL`        | Gemini model identifier                                           | Optional (defaulted)            | `gemini-3.8-flash`                 | `api`, `worker`, `assessment-engine` | Defaults to `gemini-3.8-flash` across code and `.env.example`.               |
| `GEMINI_TIMEOUT_MS`   | Upstream Gemini HTTP request timeout in ms                        | Optional                        | `30000`                            | `api`, `worker`, `assessment-engine` | Clamped to `1000..120000` in API `env.ts`.                                   |
| `ASSESSMENT_PROVIDER` | AI backend selector (`gemini` or `fake`)                          | Optional (prod checks `gemini`) | `gemini`                           | `api`, `worker`, `preflight-env.mjs` | `fake` is strictly rejected outside `NODE_ENV=test`.                         |

#### Object Storage (OCI S3-Compatible / Local Dev)

| Variable Name                       | Purpose                                                             | Required / Optional           | Example Placeholder / Safe Default                                      | Consuming Services                   | Security Notes                                                    |
| :---------------------------------- | :------------------------------------------------------------------ | :---------------------------- | :---------------------------------------------------------------------- | :----------------------------------- | :---------------------------------------------------------------- |
| `STORAGE_DRIVER`                    | Resume binary storage adapter (`s3` or `local`)                     | Required                      | `s3` (prod), `local` (dev)                                              | `api`, `worker`, `preflight-env.mjs` | `s3` is mandatory in production; `local` rejected in prod.        |
| `ALLOW_LOCAL_STORAGE_IN_PRODUCTION` | Legacy staging escape flag for local storage                        | Optional (must be `false`)    | `false`                                                                 | `api`, `preflight-env.mjs`           | Rejected in `NODE_ENV=production` even if `true`.                 |
| `S3_BUCKET`                         | Private S3/OCI bucket holding opaque `YYYY-MM/<uuid>.<ext>` objects | Required when `s3`            | `talentlens-resumes`                                                    | `api`, `worker`, `preflight-env.mjs` | Bucket must block all public ACLs/policies.                       |
| `S3_REGION`                         | S3/OCI object storage region                                        | Required when `s3`            | `ap-hyderabad-1` (prod), `us-east-1` (AWS/test default)                 | `api`, `worker`, `preflight-env.mjs` | Used in AWS SigV4 credential scope signing.                       |
| `S3_ENDPOINT`                       | Dedicated OCI/S3-compatible endpoint base URL                       | Required for OCI/MinIO/S3Mock | `https://<ns>.compat.objectstorage.ap-hyderabad-1.oci.customer-oci.com` | `api`, `worker`, `preflight-env.mjs` | Use HTTPS in production; validated as URL.                        |
| `S3_ACCESS_KEY_ID`                  | S3/OCI Customer Secret Key access ID                                | Required when `s3`            | `<oci-s3-access-key>`                                                   | `api`, `worker`, `preflight-env.mjs` | Scope IAM/Customer Secret Key strictly to target bucket.          |
| `S3_SECRET_ACCESS_KEY`              | S3/OCI Customer Secret Key secret                                   | Required when `s3`            | `<oci-s3-secret-key>`                                                   | `api`, `worker`, `preflight-env.mjs` | Secret key; minimum 16 chars enforced by preflight.               |
| `S3_FORCE_PATH_STYLE`               | Use path-style S3 URLs (`<endpoint>/<bucket>/<key>`)                | Optional                      | `true`                                                                  | `api`, `worker`                      | Recommended `true` for OCI compatibility & S3Mock.                |
| `RESUME_STORAGE_ROOT`               | Filesystem root directory when `STORAGE_DRIVER=local`               | Dev only                      | `./storage/resumes`                                                     | `api`, `worker`                      | Ignored when `STORAGE_DRIVER=s3`; path traversal checks enforced. |

#### Antivirus Scanner (ClamAV)

| Variable Name         | Purpose                                                | Required / Optional     | Example Placeholder / Safe Default | Consuming Services         | Security Notes                                                |
| :-------------------- | :----------------------------------------------------- | :---------------------- | :--------------------------------- | :------------------------- | :------------------------------------------------------------ |
| `SCANNER_DRIVER`      | Malware scanning backend (`clamav` or `mock`)          | Required                | `clamav` (prod), `mock` (dev)      | `api`, `preflight-env.mjs` | Production Compose pins `clamav`.                             |
| `CLAMAV_HOST`         | Hostname or IP of `clamd` daemon                       | Required when `clamav`  | `clamav`                           | `api`, `preflight-env.mjs` | Internal Docker hostname (`clamav`) avoids external exposure. |
| `CLAMAV_PORT`         | TCP port for `clamd` `zINSTREAM` protocol              | Optional                | `3310`                             | `api`                      | Default `3310`.                                               |
| `SCANNER_FAIL_CLOSED` | Reject uploads when ClamAV is unreachable or times out | Required `true` in prod | `true`                             | `api`, `preflight-env.mjs` | `false` is rejected in `production` and `staging`.            |

#### Cryptographic Email Outbox Secrets

| Variable Name                     | Purpose                                                         | Required / Optional      | Example Placeholder / Safe Default                   | Consuming Services                   | Security Notes                                                                               |
| :-------------------------------- | :-------------------------------------------------------------- | :----------------------- | :--------------------------------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------- |
| `EMAIL_OUTBOX_ENCRYPTION_KEY`     | Active AES-256-GCM (`v1`) key encrypting queued emails          | Required in prod/staging | _(64 hex chars / 32 bytes via `generate:secrets`)_   | `api`, `worker`, `preflight-env.mjs` | Must be identical on `api` and `worker`; fail-closed in prod/staging.                        |
| `EMAIL_OUTBOX_PREVIOUS_KEYS`      | Comma-separated retired decryption keys (`keyId:64hex,...`)     | Optional (rotation)      | `v0:<64-hex-chars>`                                  | `api`, `worker`                      | Read-only decryption keyring during key rotation; never reuse across envs.                   |
| `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` | Dedicated HMAC-SHA256 secret for `email_outbox.idempotency_key` | Required in prod/staging | _(>=32 bytes / 64 hex chars via `generate:secrets`)_ | `api`, `worker`, `preflight-env.mjs` | Must be independent of encryption key so emails stay hashed at rest without plaintext leaks. |

#### Transactional Email (SMTP)

| Variable Name | Purpose                                                        | Required / Optional        | Example Placeholder / Safe Default              | Consuming Services                   | Security Notes                                                  |
| :------------ | :------------------------------------------------------------- | :------------------------- | :---------------------------------------------- | :----------------------------------- | :-------------------------------------------------------------- |
| `SMTP_HOST`   | Transactional SMTP relay hostname                              | Required in prod           | `smtp.email.ap-hyderabad-1.oci.oraclecloud.com` | `api`, `worker`, `preflight-env.mjs` | Worker startup fails closed if empty in `production`/`staging`. |
| `SMTP_PORT`   | SMTP port (`587` STARTTLS, `465` direct TLS, `1025` Mailpit)   | Required in prod           | `587`                                           | `api`, `worker`, `preflight-env.mjs` | `SmtpClient` defaults TLS/STARTTLS based on port.               |
| `SMTP_USER`   | SMTP authentication username (OCI Email Delivery OCID or user) | Optional (relay dependent) | `<smtp-username>`                               | `api`, `worker`                      | Secret credential when relay requires `AUTH`.                   |
| `SMTP_PASS`   | SMTP authentication password                                   | Optional (relay dependent) | `<smtp-password>`                               | `api`, `worker`                      | Secret credential; never commit or echo.                        |
| `EMAIL_FROM`  | Envelope and `From:` sender email address                      | Required                   | `no-reply@talentlens.ai`                        | `api`, `worker`, `preflight-env.mjs` | Must match authorized OCI/SES sender domain (SPF/DKIM aligned). |

#### Candidate Consent Governance

| Variable Name                      | Purpose                                                     | Required / Optional | Example Placeholder / Safe Default | Consuming Services          | Security Notes                                                                 |
| :--------------------------------- | :---------------------------------------------------------- | :------------------ | :--------------------------------- | :-------------------------- | :----------------------------------------------------------------------------- |
| `CONSENT_APPROVED_POLICY_VERSIONS` | Comma-separated approved consent policy version identifiers | Required            | `2026-11-v1`                       | `api`, `preflight-env.mjs`  | Governs accepted candidate consent notices when strict hash pinning isn't set. |
| `CONSENT_APPROVED_POLICIES`        | Optional strict `<version>:<sha256HexHash>` pinning list    | Optional            | `2026-11-v1:<64hex>`               | `api` (`consent.policy.ts`) | Cryptographically binds policy version to exact SHA-256 notice text.           |

### 2. Additional Runtime, OCR, Deployment, Backup & Testing Variables

Used by specific modules, Docker/OCI operational scripts, and isolated tests outside `.env.example`:

| Variable Name                                                                                                          | Purpose                                                          | Required / Optional | Default / Example                                                           | Consuming Component                                            | Security Notes                                                                                                                            |
| :--------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------- | :------------------ | :-------------------------------------------------------------------------- | :------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS`, `ASSESSMENT_TIMEOUT_MS`                                                     | Legacy/fallback aliases for Gemini configuration                 | Optional            | Mapped from `GEMINI_*` (`gemini-3.8-flash`, `30000`)                        | `api` `env.ts`, `assessment-engine`                            | Prefer canonical `GEMINI_*` variables.                                                                                                    |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`                                                             | Fallback AWS SDK-style env names if `S3_*` omitted               | Optional            | Falls back after `S3_*`                                                     | `api`/`worker` storage                                         | Prefer `S3_*` variables.                                                                                                                  |
| `SMTP_SECURE`, `SMTP_REQUIRE_TLS`                                                                                      | Explicit SMTPS (`true`/`false`) and mandatory STARTTLS override  | Optional            | Auto (`465` secure, `587` `requireTls`)                                     | `worker` (`email-dispatcher.ts`), `api`                        | Certificate check (`rejectUnauthorized: true`) remains enforced for TLS; only disable `SMTP_REQUIRE_TLS=false` on isolated local Mailpit. |
| `TESSERACT_PATH`, `PDFTOPPM_PATH`, `PDFINFO_PATH`                                                                      | Override executable paths for OCR & PDF geometry inspection      | Optional            | `tesseract`, `pdftoppm`, `pdfinfo`                                          | `document-processing` (`ocr.ts`)                               | Alpine packages already place these on `PATH` inside `worker`.                                                                            |
| `WORKER_READINESS_FILE`, `WORKER_HEARTBEAT_MAX_AGE_MS`                                                                 | Path & staleness limit for worker readiness JSON heartbeat       | Optional            | `<tmpdir>/talentlens-worker-ready.json`, `45000`                            | `worker` (`index.ts`, `healthcheck.ts`, `readiness.ts`)        | Used by Docker container healthcheck (`healthcheck.js`).                                                                                  |
| `COMPOSE_FILE`, `ENV_FILE`, `COMPOSE_PROJECT_NAME`                                                                     | Target Compose file, env file, and project namespace for deploy  | Optional            | `docker-compose.prod.yml`, `.env`, `talentlens`                             | `deploy.sh`, `backup.sh`, `restore.sh`                         | Essential when deploying OCI overrides or candidate env files.                                                                            |
| `CADDYFILE_PATH`, `CADDY_CONF_D` / `CONF_D`, `LOG_DIR`, `APP_DOMAIN`                                                   | Host Caddy setup/validation paths and domain override            | Optional            | `/etc/caddy/Caddyfile`, `/etc/caddy/conf.d`, `/var/log/caddy`               | `deploy.sh`, `scripts/setup-caddy.sh`                          | Do not disable host Caddy validation.                                                                                                     |
| `DOCKER_BIN`, `CADDY_BIN`, `SYSTEMCTL_BIN`, `CURL_BIN`, `NODE_BIN`                                                     | Binary overrides for deployment automation & mock harness tests  | Optional            | `docker`, `caddy`, `systemctl`, `curl`, `node`                              | `deploy.sh`, `backup.{sh,ps1}`, `restore.{sh,ps1}`             | Leave defaults in normal operations.                                                                                                      |
| `DEPLOY_DB_RETRIES`, `DEPLOY_CLAMAV_RETRIES`, `DEPLOY_SERVICE_RETRIES`, `DEPLOY_HTTPS_RETRIES`, `DEPLOY_POLL_INTERVAL` | Retry/poll timing tuning in `deploy.sh`                          | Optional            | `30`, `100`, `30`, `5`, `2` (seconds)                                       | `deploy.sh`                                                    | ClamAV allows extra cold-start time for signature DB load.                                                                                |
| `TALENTLENS_DEPLOY_TEST_MODE`, `DEPLOY_HTTPS_CURL_CA`, `DEPLOY_CURL_RESOLVE`                                           | Isolated deployment self-test hooks for custom CA (`--cacert`)   | Test only           | `0`, empty                                                                  | `deploy.sh`                                                    | Blocked when `TALENTLENS_DEPLOY_TEST_MODE != 1`; `-k`/insecure TLS is never allowed.                                                      |
| `BACKUP_DIR`, `RETENTION_DAYS`, `TARGET_CONTAINER`, `BACKUP_FORMAT`                                                    | Backup script defaults overridable by CLI flags                  | Optional            | `/var/backups/talentlens` (`.sh`) / `backups` (`.ps1`), `7`, empty, `plain` | `scripts/backup.{sh,ps1}`                                      | Restrict permissions on target directory (`chmod 700` / restricted ACLs).                                                                 |
| `TARGET_ENV`, `ENV_PATH`                                                                                               | Target env file override for secret generation / preflight       | Optional            | `.env`                                                                      | `generate-secrets.mjs`, `preflight-env.mjs`                    | Useful when creating `.env.candidate` safely.                                                                                             |
| `TALENTLENS_RUN_PG_INTEGRATION`, `TALENTLENS_INTEGRATION_DATABASE_URL`                                                 | Opt-in gate & target URI for real PostgreSQL integration suites  | Test only           | unset                                                                       | `*.integration.test.ts`, `email-dispatcher.test.ts`            | Always point to a disposable local/CI test database, never production.                                                                    |
| `TALENTLENS_E2E_ENV`, `TALENTLENS_E2E_TOPOLOGY`, `MAILPIT_URL`, `CHROME_EXECUTABLE_PATH`, `TALENTLENS_ARTIFACT_DIR`    | E2E safety-guard markers, browser binary, and artifact directory | Test only           | `local-isolated` / `compose-isolated`, `artifacts/{e2e,visual-qa}`          | `run-browser-e2e.mjs`, `visual-qa.mjs`, `e2e-safety-guard.mjs` | Safety guard fails closed unless pointed exclusively at approved E2E test infrastructure.                                                 |

---

## C. Production Deployment Architecture

Verified OCI production topology for `https://talentlens-ai.duckdns.org` (Repository: `https://github.com/Lokaprathap22/TalentLens-Ai`):

- **Compute Host:** OCI Ubuntu 24.04 VM.
- **Database:** PostgreSQL 17 (`postgres:17-alpine`, container `talentlens-postgres`) backed by persistent volume `talentlens_pgdata`.
- **Reverse Proxy & TLS:** Host-managed `caddy` systemd service handling Let's Encrypt / ZeroSSL ACME certificates on ports `80`/`443` and reverse-proxying HTTPS requests to `http://127.0.0.1:8080`.
- **Runtime Containers (5 active services + 1 one-shot migration job):**
  1. `talentlens-web` — `nginxinc/nginx-unprivileged:alpine` listening on `127.0.0.1:8080:8080`, serving built Vite React static bundles and proxying `/api/` (`client_max_body_size 50M`) to `http://api:3000`.
  2. `talentlens-api` — Express 5 API on internal port `3000`, **constrained to `replicas: 1`** due to in-memory `express-rate-limit` counters.
  3. `talentlens-worker` — Polling processor & encrypted SMTP outbox dispatcher, containing `tesseract-ocr`, `tesseract-ocr-data-eng`, and `poppler-utils`.
  4. `talentlens-postgres` — PostgreSQL 17 database (`talentlens_pgdata`).
  5. `talentlens-clamav` — ClamAV antivirus daemon (`clamd` listening internally on `:3310`, signature volume `talentlens_clamav_db`).
  - _(One-shot)_ `talentlens-migration` — Runs `prisma migrate deploy` prior to `api`/`worker` startup.
- **Docker Network & Firewall:**
  - Internal isolated bridge network: `talentlens_internal`.
  - OCI VCN Security List & Ubuntu UFW allow inbound TCP `80` and `443` only; internal ports `3000`, `5432`, `8080`, and `3310` are never published on public interfaces (`web` binds strictly to `127.0.0.1:8080`).

```mermaid
flowchart LR
    INTERNET["Internet Users"] -->|"HTTPS 443 and HTTP 80 (OCI VCN)"| CADDY["Host Caddy (systemd TLS proxy)"]
    CADDY -->|"HTTP 127.0.0.1:8080"| WEB["talentlens-web (Nginx unprivileged :8080)"]

    subgraph INTERNAL["Docker Network: talentlens_internal"]
        WEB -->|"Proxy /api/* -> api:3000"| API["talentlens-api (Express :3000, replicas=1)"]
        API -->|"zINSTREAM :3310 (fail-closed)"| CLAM["talentlens-clamav (:3310)"]
        API -->|"Prisma SQL :5432"| PG[("talentlens-postgres (PG 17)")]
        WORKER["talentlens-worker (Poppler + Tesseract)"] -->|"SKIP LOCKED & heartbeats"| PG
        CLAM --- VOL_CLAM[("Volume: talentlens_clamav_db")]
        PG --- VOL_PG[("Volume: talentlens_pgdata")]
    end

    API -->|"SigV4 HTTPS PUT/GET/DELETE (AES256)"| S3[("OCI Object Storage S3")]
    API -->|"JD Extraction API"| GEMINI["Google Gemini API"]
    WORKER -->|"SigV4 GET"| S3
    WORKER -->|"CV Assessment API"| GEMINI
    WORKER -->|"STARTTLS 587 / TLS 465"| SMTP["OCI / Transactional SMTP"]
```

---

## D. Important Actual Deployment State (OCI Live vs Repository Baseline)

> [!CAUTION]
> **Do not assume `/home/ubuntu/TalentLens-AI` is the live active deployment directory.**
>
> The production deployment currently serving `https://talentlens-ai.duckdns.org` runs from a dedicated release-staging workspace so legacy host configuration remained undisturbed.

### Verified Live Production State (November 10, 2026)

| Item                           | Live OCI Value                                                                   | Notes                                                             |
| :----------------------------- | :------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| **Active source directory**    | `/home/ubuntu/talentlens-release-staging-20261110/source`                        | Extracted from verified `TalentLens-AI-FINAL-RELEASE-AUDIT.zip`   |
| **Active OCI Compose file**    | `/home/ubuntu/talentlens-release-staging-20261110/source/docker-compose.oci.yml` | Server-specific override attaching to pre-existing external infra |
| **Active production env file** | `/home/ubuntu/talentlens-release-staging-20261110/.env.candidate`                | Holds live secrets (`chmod 600`); not tracked in Git              |
| **Preserved legacy `.env`**    | `/home/ubuntu/TalentLens-AI/.env`                                                | Explicitly preserved untouched during rollout                     |
| **Compose project name**       | `talentlens`                                                                     | Ensures deterministic container and resource naming               |

### Canonical Repository Compose vs OCI Override Comparison

| Property                 | Canonical [docker-compose.prod.yml](./docker-compose.prod.yml) | Live Server Override (`docker-compose.oci.yml`)                |
| :----------------------- | :------------------------------------------------------------- | :------------------------------------------------------------- |
| **Network definition**   | Compose-managed `internal` (`172.28.0.0/16`)                   | Attaches to pre-existing external `talentlens_internal`        |
| **Static container IPs** | `web`: `172.28.0.10`, `api`: `172.28.0.20`                     | `web`: `172.18.0.10`, `api`: `172.18.0.20`                     |
| **Persistent volumes**   | Compose-scoped `pgdata` and `clamav_db`                        | Reuses external `talentlens_pgdata` and `talentlens_clamav_db` |
| **ClamAV image ref**     | `clamav/clamav:1.4`                                            | Reuses existing local ClamAV image reference on the OCI VM     |

### Architecture Decision: Why `docker-compose.oci.yml` Is Documented as a Server Override (Not Committed to Git)

The repository intentionally keeps [docker-compose.prod.yml](./docker-compose.prod.yml) as the sole maintained canonical production Compose definition rather than fabricating or committing `docker-compose.oci.yml`:

1. **Portability vs. Host Coupling:** Hard-coding pre-existing external network names, VM-specific subnets (`172.18.0.0/16`), external volume bindings, and local-only image tags into Git would break clean greenfield deployments on new hosts and conflict with `TRUSTED_PROXY_IPS` defaults in `.env.example` (`172.28.0.10,172.28.0.1,127.0.0.1`).
2. **Source-of-Truth Integrity:** `docker-compose.oci.yml` was authored as a host-side adaptation around pre-existing OCI infrastructure rather than in this workstation's source tree; reconstructing server-only files from memory would violate factual accuracy guarantees.
3. **Built-in Tooling Support:** [deploy.sh](./deploy.sh) natively accepts `COMPOSE_FILE`, `ENV_FILE`, and `COMPOSE_PROJECT_NAME`, allowing OCI operators to pass `docker-compose.oci.yml` and `.env.candidate` cleanly without dirtying tracked Git state.

---

## E. Production Deployment Procedure

Never deploy production by blindly running `git pull` inside the active directory — a dirty tree, unmigrated database state, missing environment preflight, or overwritten `.env` can leave `api` and `worker` out of sync with PostgreSQL.

### Controlled 15-Step Release Procedure

1. **Verify exact release source or tag:** Confirm the Git commit/tag or release archive matches the reviewed, tested artifact.
2. **Transfer to a dedicated staging directory:** Upload the release archive (never raw `.env` or dumps) to a versioned server staging directory (for example `/home/ubuntu/talentlens-release-staging-YYYYMMDD`).
3. **Validate archive SHA-256 checksum:**
   ```bash
   sha256sum TalentLens-AI-FINAL-RELEASE-AUDIT.zip
   ```
   Verify the digest matches the recorded release checksum before extracting.
4. **Extract into an isolated release subdirectory:**
   ```bash
   mkdir -p /home/ubuntu/talentlens-release-staging-YYYYMMDD/source
   unzip -q TalentLens-AI-FINAL-RELEASE-AUDIT.zip -d /home/ubuntu/talentlens-release-staging-YYYYMMDD/source
   cd /home/ubuntu/talentlens-release-staging-YYYYMMDD/source
   ```
5. **Install locked dependencies if host scripts need `node_modules`:** (for running `preflight-env.mjs` / `generate-secrets.mjs` with `dotenv` on the host):
   ```bash
   npm ci --ignore-scripts
   ```
6. **Prepare candidate environment file (`ENV_FILE`):** Copy `/home/ubuntu/TalentLens-AI/.env` (or `.env.example` + `npm run generate:secrets -- --target ../.env.candidate --write`), fill/verify S3, Gemini, SMTP, `APP_ORIGIN`, and align `TRUSTED_PROXY_IPS` with the Compose network subnet (`172.18.0.0/16` or `172.28.0.0/16`), then restrict permissions:
   ```bash
   chmod 600 ../.env.candidate
   ```
7. **Run fail-closed environment preflight:**
   ```bash
   node scripts/preflight-env.mjs ../.env.candidate
   ```
   Abort immediately if any `[FAIL]` check appears.
8. **Validate Compose configuration without exposing secrets:**
   ```bash
   COMPOSE_FILE=docker-compose.oci.yml ENV_FILE=../.env.candidate COMPOSE_PROJECT_NAME=talentlens \
     docker compose -p "${COMPOSE_PROJECT_NAME}" --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}" config --quiet
   ```
9. **Create and verify a pre-deployment PostgreSQL backup:** (see exact flags in [Section F](#f-backup-and-restore)):
   ```bash
   ./scripts/backup.sh -f docker-compose.oci.yml --env-file ../.env.candidate
   ```
10. **Pre-build application images (`web`, `api`, `worker`):** _(Note: `deploy.sh` also executes `build web api worker` automatically after preflight passes.)_
    ```bash
    docker compose -p talentlens --env-file ../.env.candidate -f docker-compose.oci.yml build web api worker
    ```
11. **Inspect current Prisma migration status before mutating schema:**
    ```bash
    docker compose -p talentlens --env-file ../.env.candidate -f docker-compose.oci.yml \
      run --rm --no-deps api npx prisma migrate status
    ```
12. **Run controlled deployment via [deploy.sh](./deploy.sh):**
    ```bash
    COMPOSE_FILE=docker-compose.oci.yml \
    ENV_FILE=/home/ubuntu/talentlens-release-staging-20261110/.env.candidate \
    COMPOSE_PROJECT_NAME=talentlens \
    ./deploy.sh
    ```
    [deploy.sh](./deploy.sh) runs fail-closed preflight -> image build -> `postgres` health wait -> one-shot `migration` (`prisma migrate deploy`) -> `clamav` health wait -> `up -d api worker web` -> internal HTTP readiness -> worker heartbeat readiness -> non-destructive `caddy validate` + `systemctl reload caddy` -> strict HTTPS probe (`APP_ORIGIN/api/v1/health/ready`, `-k` forbidden).
13. **Verify container health & readiness state:**
    ```bash
    docker compose -p talentlens --env-file ../.env.candidate -f docker-compose.oci.yml ps
    ```
    Confirm `postgres`, `clamav`, `api`, `worker`, and `web` all report `running` / `healthy`.
14. **Verify host Caddy and strict public HTTPS:**
    ```bash
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl status caddy --no-pager
    curl -fsS -I https://talentlens-ai.duckdns.org
    curl -fsS https://talentlens-ai.duckdns.org/api/v1/health/ready
    ```
15. **Run controlled functional smoke tests:** Verify recruiter authentication and dashboard telemetry (verified on November 10, 2026), and schedule controlled non-destructive smoke tests for **resume upload/OCR/AI assessment** and the **complete client hiring-manager portal workflow** (currently pending in OCI production).

### `COMPOSE_FILE`, `ENV_FILE`, and `COMPOSE_PROJECT_NAME` Behavior

- `COMPOSE_FILE` (default: `docker-compose.prod.yml`): Selects either the canonical repo topology or a host-specific override (`docker-compose.oci.yml`).
- `ENV_FILE` (default: `.env`): Supplies Compose variable interpolation and is inspected by `deploy.sh` / `preflight-env.mjs` without printing secret values.
- `COMPOSE_PROJECT_NAME` (default: `talentlens`): Names containers (`${COMPOSE_PROJECT_NAME}-api`, `-worker`, `-web`, `-postgres`, `-clamav`, `-migration`) consistently across rollouts so existing volumes and networks remain matched.

---

## F. Backup and Restore

TalentLens AI provides deterministic, checksum-verified backup and fail-closed restore automation in [scripts/backup.sh](./scripts/backup.sh), [scripts/backup.ps1](./scripts/backup.ps1), [scripts/restore.sh](./scripts/restore.sh), and [scripts/restore.ps1](./scripts/restore.ps1).

### 1. Backup Creation & Exact Script Syntax

- **Bash (`scripts/backup.sh`):**

  ```text
  Usage: ./scripts/backup.sh [options]
    -d, --database <name>       Target PostgreSQL database name (default: POSTGRES_DB or talentlens)
    -u, --user <name>           PostgreSQL role name (default: POSTGRES_USER or talentlens)
    -o, --backup-dir <dir>      Output backup directory (default: /var/backups/talentlens)
    -r, --retention-days <days> Positive integer retention days (default: 7)
    -f, --compose-file <file>   Compose file path (default: docker-compose.prod.yml)
    -c, --container <name>      Explicit PostgreSQL container name
        --format <plain|custom> Archive format: plain (.sql.gz, default) or custom (.dump)
        --env-file <file>       Optional env file for safe variable lookup (default: .env)
  ```

  Example (OCI production):

  ```bash
  ./scripts/backup.sh -f docker-compose.oci.yml --env-file ../.env.candidate --format custom
  ```

- **Windows PowerShell (`scripts/backup.ps1`):**
  Parameters: `-Database`, `-User`, `-BackupDir` (default `backups`), `-RetentionDays` (default `7`), `-ComposeFile` (default `docker-compose.prod.yml`), `-TargetContainer`, `-Format <plain|custom>`, `-EnvFile` (default `.env`), `-DockerBin` (default `docker`).

  Example (Windows local Docker Compose):

  ```powershell
  .\scripts\backup.ps1 -ComposeFile docker-compose.yml -Format custom -BackupDir backups
  ```

### 2. Location, Permissions, Integrity & Retention Guarantees

- **Location & Git Safety:** `.sh` defaults to `/var/backups/talentlens`; `.ps1` defaults to `./backups`. Both `.gitignore` and `.dockerignore` exclude `/backups/` and `*.sql`, `*.sql.gz`, `*.sql.gz.sha256`, `*.dump`, and `*.dump.sha256`.
- **Host Permissions:** `backup.sh` sets `chmod 700` on the backup directory and `chmod 600` on every archive and `.sha256` sidecar. `backup.ps1` applies `icacls /inheritance:r` granting access strictly to the current user, `SYSTEM` (`S-1-5-18`), and `Administrators` (`S-1-5-32-544`).
- **Archive Integrity Checks:**
  - `plain` (`.sql.gz`): Runs `gzip -t` (or `.NET GZipStream` decompression test in `.ps1`) and verifies decompressed payload size > 0 bytes.
  - `custom` (`.dump`): Verifies the `PGDMP` (`0x5047444d50`) magic header and validates archive contents with `pg_restore --list`.
- **SHA-256 Sidecar Verification:** Writes `<archive>.sha256`, moves temp files atomically, and re-reads both files from disk to verify digest parity before reporting success.
- **Retention Policy:** Deletes expired `talentlens_db_*` archives (and matching `.sha256` sidecars) strictly older than `RetentionDays` **only after** the new backup and checksum verify cleanly, and never deletes the newly created backup or the newest valid archive overall.
- **Off-Host Encryption Note:** Backup scripts emit compressed `.sql.gz` or PostgreSQL custom `.dump` files, not encrypted archives. Encrypt backups out-of-band (for example client-side `age`/`gpg` or KMS-managed SSE) before uploading to off-host OCI Object Storage with versioning enabled.

### 3. Restore Procedure & Verification

- **Bash (`scripts/restore.sh`):**

  ```text
  Usage: ./scripts/restore.sh [options] <backup_archive> <target_database>
        --confirm-replace-existing  Required to restore into an existing database
        --create-target             Create target database if it does not already exist
    -c, --container <name>          Explicit PostgreSQL container name
    -f, --compose-file <file>       Compose file path (default: docker-compose.prod.yml)
    -u, --user <name>               PostgreSQL role name (default: POSTGRES_USER or talentlens)
        --env-file <file>           Optional env file for safe variable lookup (default: .env)
  ```

- **Windows PowerShell (`scripts/restore.ps1`):**
  Positional / named parameters: `-Archive <path>`, `-TargetDb <name>`, `-ConfirmReplaceExisting`, `-CreateTarget`, `-User`, `-TargetContainer`, `-ComposeFile`, `-EnvFile`, `-DockerBin`.

**Recommended Verification Drill (Non-Destructive Staging Database):**

```bash
# Bash (Linux / OCI)
./scripts/restore.sh \
  -f docker-compose.oci.yml \
  --env-file ../.env.candidate \
  --create-target \
  /var/backups/talentlens/talentlens_db_YYYYMMDD_HHMMSSZ.dump \
  talentlens_restore_verify
```

```powershell
# PowerShell (Windows)
.\scripts\restore.ps1 `
  -ComposeFile docker-compose.yml `
  -Archive backups\talentlens_db_YYYYMMDD_HHMMSSZ.dump `
  -TargetDb talentlens_restore_verify `
  -CreateTarget
```

**Production In-Place Disaster Recovery Preconditions:** Stop `api` and `worker` (`docker compose stop api worker`) before passing `--confirm-replace-existing` against the live database so active leases and connections do not race the single-transaction restore (`psql --single-transaction -v ON_ERROR_STOP=1` or `pg_restore --single-transaction --exit-on-error`).

**Automated Post-Restore Checks:** Both restore scripts verify:

1. Database connectivity (`SELECT 1`) and presence of `public` schema.
2. Applied migration count in `public._prisma_migrations` (`finished_at IS NOT NULL AND rolled_back_at IS NULL`).
3. Existence and printed row counts across all 10 core domain tables:
   `organizations`, `users`, `clients`, `requisitions`, `scorecard_versions`, `candidates`, `candidate_consents`, `email_outbox`, `resume_documents`, `candidate_assessments`.

---

## G. Login and Account Access

TalentLens AI has **no public self-registration** and **no seeded default passwords or public demo accounts**. Every account begins as `INVITED` (`passwordHash: null`) and activates using a one-time cryptographic token (`32` random bytes encoded as `base64url` for user security tokens; stored strictly as SHA-256 hex digests in the database).

### 1. Initial Organization & Recruiter Bootstrap

Run the bootstrap CLI to create the organization and first `RECRUITER` account (`INVITED`), optionally printing the 48-hour activation link when SMTP is not yet used for the operator's own onboarding:

- **In Production (OCI Compose):**
  ```bash
  docker compose -p talentlens --env-file ../.env.candidate -f docker-compose.oci.yml exec api \
    node apps/api/dist/scripts/bootstrap.js "Your Organization Name" "recruiter@yourdomain.com" --print-activation-link
  ```
- **In Local Development:**
  ```bash
  npm run bootstrap --workspace @talentlens/api -- "Your Organization Name" "recruiter@yourdomain.com" --print-activation-link
  ```

By default, running `bootstrap` without `--print-activation-link` (or `--print-token`) redacts the bearer token. Operators should transmit printed activation links over an encrypted channel and never commit or log them.

### 2. Recruiter Sign-In, Activation & Password Reset

- **Account Activation (`/activate#token=...`):** Opening the activation URL places the token in the URL hash fragment (never sent to HTTP access logs or referrer headers). Submitting the form calls `POST /api/v1/auth/activate`, hashes the user-chosen password with **Argon2id** (`m=19456, t=2, p=1, hashLength=32`), transitions `status` from `INVITED` to `ACTIVE`, consumes the single-use `user_security_tokens` row, and sets the HttpOnly session cookie (`__Host-talentlens_session` in production, `talentlens_session` in development).
- **Recruiter Login (`/login`):** Requires **Organization Name**, **Email**, and **Password** (`POST /api/v1/auth/login`), returning an 8-hour stateful PostgreSQL session and deriving per-session HMAC-SHA256 CSRF tokens via `GET /api/v1/auth/csrf`.
- **Password Reset (`/reset-password`):** Users request a 1-hour `PASSWORD_RESET` token via `POST /api/v1/auth/password/reset/request` (anti-enumeration safe; queued through `email_outbox`) and confirm at `/reset-password#token=...` (`POST /api/v1/auth/password/reset/confirm`), which updates `passwordHash` and revokes existing sessions.

### 3. Client Hiring Manager Invitation & Portal Access

1. An authenticated `RECRUITER` creates or opens a `Client` (`/clients/:clientId`) and submits the invitation dialog (`POST /api/v1/clients/:clientId/members/invite`), specifying the hiring manager's email and optional name.
2. The API creates/links the `User` with `role = CLIENT_HIRING_MANAGER`, creates an active `ClientMembership`, generates a 48-hour `ACTIVATION` token in `user_security_tokens`, and enqueues an encrypted activation email in `email_outbox`.
3. `talentlens-worker` dispatches the activation email over SMTP containing `<APP_ORIGIN>/activate#token=<rawToken>`.
4. After activating, signing in as `CLIENT_HIRING_MANAGER` routes directly to the scoped **Client Dashboard** (`/dashboard`), **Client Portal** (`/client-portal`), and shared **Interviews** view (`/interviews`). Client portal responses mask candidate contact details (`email`/`phone`) and restrict visibility strictly to submissions belonging to that user's active client memberships.

### 4. Candidate Self-Service Links (Consent, Withdrawal & Deletion)

All candidate self-service links pass tokens via URL hash fragments (`#token=...`) and inspect/submit via `POST` bodies so tokens do not leak through HTTP URLs:

- **Consent Portal (`/consent#token=...`):** Triggered from a requisition candidate detail view; calls `POST /api/v1/consent/inspect` to render the exact `noticeText` snapshot and policy version (`2026-11-v1`), then submits `POST /api/v1/consent/accept` or `POST /api/v1/consent/decline`.
- **Consent Withdrawal (`/consent/withdraw`):** Initiates a 24-hour verification link (`POST /api/v1/consent/withdraw/request`) and confirms via `#token=...` (`POST /api/v1/consent/withdraw/confirm`), halting pending/held worker AI processing and future submissions for that scope.
- **Self-Service Data Deletion (`/consent/deletion`):** Initiates a 24-hour verification link (`POST /api/v1/consent/deletion/request`) and confirms via `#token=...` (`POST /api/v1/consent/deletion/confirm`), triggering atomic candidate deletion verification, database PII erasure, queued outbox cancellation, and deletion of private S3/local resume objects.
