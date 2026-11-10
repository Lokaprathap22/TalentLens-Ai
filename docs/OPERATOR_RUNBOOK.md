# TalentLens AI — Production Operations & Deployment Runbook

- **Last verified:** November 10, 2026
- **Related documentation:**
  - [README.md](../README.md) — project overview, journeys, and quick start
  - [deployment.md](../deployment.md) — reproducible local setup, OCI staging/production release runbook, and backup/restore syntax
  - [TECHNICAL_DESIGN_DOCUMENT.md](./TECHNICAL_DESIGN_DOCUMENT.md) — full architecture, data model, security, and processing design

This document is the operational guide for provisioning, securing, and maintaining the TalentLens AI recruitment platform in staging and production environments.

---

## 1. Initial Organization & Recruiter Provisioning

TalentLens AI enforces strict multi-tenancy and does not allow unauthenticated public sign-ups or default hard-coded administrator credentials.

### Secure CLI Bootstrap Procedure

To provision the first tenant organization and the initial invited recruiter account (`status: INVITED`, `passwordHash: null`):

**In Production (Docker Environment):**

```bash
docker compose -p talentlens --env-file .env -f docker-compose.prod.yml exec api \
  node apps/api/dist/scripts/bootstrap.js "Enterprise Client Name" "recruiter.admin@client.com" --print-activation-link
```

**In Local Development:**

```bash
npm run bootstrap --workspace @talentlens/api -- "Enterprise Client Name" "recruiter.admin@client.com" --print-activation-link
```

### Operational Characteristics:

- **One-Time Activation Link (No Temporary Passwords)**: Generates a 32-byte (`randomBytes(32)`) URL-safe base64url activation token, stores only its SHA-256 hex digest in `user_security_tokens` (`type = ACTIVATION`, 48-hour TTL), and leaves `passwordHash` as `NULL` until activation.
- **Concealed Output by Default**: The script conceals the bearer activation URL (`<APP_ORIGIN>/activate#token=<token>`) unless `--print-activation-link` (or `--print-token`) is explicitly passed.
- **Argon2id Password Setup**: On `/activate`, the recruiter sets their own password, which is hashed with Argon2id (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`, `hashLength: 32`), activates the user (`status: ACTIVE`), and establishes an authenticated session.
- **Normalized Multi-Tenant Collision Check**: Normalizes organization name (`normalized_name`) before creation and rejects duplicate organization names cleanly.
- **Secure Delivery**: When printing the offline activation link, transmit it only over an encrypted channel and never paste it into shared logs or chat history.

---

## 2. Production Secret Generation

Every production secret must be generated with cryptographically strong pseudo-random number generators. Never reuse keys between staging and production.

TalentLens AI provides an automated, idempotent secret generator script:

```bash
# Preview generated secrets without modifying files:
npm run generate:secrets

# Apply generated secrets into .env from .env.example (preserves all manual credentials):
npm run generate:secrets -- --write
```

Manual generation commands (if generating out-of-band):

```bash
# 1. Dedicated AES-256-GCM Email Outbox Payload Encryption Key (exactly 32 bytes / 64 hex chars)
openssl rand -hex 32
# Set as: EMAIL_OUTBOX_ENCRYPTION_KEY=<generated-hex-string>

# 2. Dedicated HMAC-SHA-256 Secret for Email Idempotency Keys (at least 32 bytes / 64 hex chars)
openssl rand -hex 32
# Set as: EMAIL_OUTBOX_IDEMPOTENCY_SECRET=<generated-hex-string>

# 3. PostgreSQL Database Password (URL-safe base64url or hex)
openssl rand -hex 24
# Set as: POSTGRES_PASSWORD=<generated-string>
```

> [!CAUTION]
> `EMAIL_OUTBOX_ENCRYPTION_KEY` and `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` must be completely independent secrets.
> Do NOT use the same string for both variables. Both API and Worker must share the exact same keys.

---

## 3. Environment Configuration

### Mandatory API Environment Variables (`apps/api`):

| Variable                          | Required    | Description                                 | Example / Notes                                                                                                   |
| :-------------------------------- | :---------- | :------------------------------------------ | :---------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | Yes         | Deployment environment mode                 | `production` or `staging`                                                                                         |
| `PORT`                            | Yes         | HTTP listening port                         | `3000`                                                                                                            |
| `DATABASE_URL`                    | Yes         | PostgreSQL connection string                | `postgresql://user:pass@postgres:5432/talentlens`                                                                 |
| `APP_ORIGIN`                      | Yes         | Strict client origin for CSRF & CORS        | `https://app.talentlens.ai` (no trailing slash/path)                                                              |
| `EMAIL_OUTBOX_ENCRYPTION_KEY`     | Yes         | Primary AES-256-GCM key for outbox          | 64-char hex string (32 bytes)                                                                                     |
| `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` | Yes         | HMAC key for deterministic outbox hashes    | 64-char hex string (32 bytes)                                                                                     |
| `STORAGE_DRIVER`                  | Yes         | Resume storage adapter                      | `s3` (mandatory in staging/production)                                                                            |
| `S3_BUCKET`                       | Yes         | Private S3 bucket name                      | `talentlens-resumes`                                                                                              |
| `S3_REGION`                       | Yes         | OCI Object Storage region                   | `ap-hyderabad-1`                                                                                                  |
| `S3_ENDPOINT`                     | Optional    | OCI S3-compatible endpoint URL              | Dedicated: `https://<ns>.compat.objectstorage.ap-hyderabad-1.oci.customer-oci.com` (or generic `oraclecloud.com`) |
| `S3_ACCESS_KEY_ID`                | Yes         | OCI Customer Secret Key Access Key          | OCI Access Key String                                                                                             |
| `S3_SECRET_ACCESS_KEY`            | Yes         | OCI Customer Secret Key Secret              | OCI Secret String                                                                                                 |
| `S3_FORCE_PATH_STYLE`             | Optional    | Enforce path style URL structure            | `true`                                                                                                            |
| `SCANNER_DRIVER`                  | Yes         | Antivirus scanner driver                    | `clamav`                                                                                                          |
| `CLAMAV_HOST`                     | Yes         | ClamAV daemon hostname                      | `clamav` (or IP)                                                                                                  |
| `CLAMAV_PORT`                     | Yes         | ClamAV daemon TCP port                      | `3310`                                                                                                            |
| `SCANNER_FAIL_CLOSED`             | Yes         | Reject uploads if scanner unreachable       | `true`                                                                                                            |
| `SMTP_HOST`                       | Yes         | Transactional SMTP server hostname          | `smtp.email.ap-hyderabad-1.oci.oraclecloud.com`                                                                   |
| `SMTP_PORT`                       | Yes         | SMTP port (587 STARTTLS or 465 SSL)         | `587`                                                                                                             |
| `SMTP_USER`                       | Optional    | SMTP authentication username                | `ocid1.user.oc1...`                                                                                               |
| `SMTP_PASS`                       | Optional    | SMTP authentication password                | SMTP password string                                                                                              |
| `EMAIL_FROM`                      | Yes         | Default sender address                      | `notifications@talentlens.ai`                                                                                     |
| `GEMINI_API_KEY`                  | Conditional | Google Gemini API key from AI Studio        | `AIzaSy...` (required unless Groq-only mode via `AI_PROVIDER_ORDER=groq`)                                         |
| `GEMINI_MODEL`                    | Optional    | Primary Free-Tier Gemini model              | `gemini-3.6-flash`                                                                                                |
| `GEMINI_FALLBACK_MODEL`           | Optional    | Bounded fallback Free-Tier Gemini model     | `gemini-3.5-flash`                                                                                                |
| `GEMINI_TIMEOUT_MS`               | Optional    | Gemini API timeout in milliseconds          | `90000` (90s)                                                                                                     |
| `AI_PROVIDER_ORDER`               | Optional    | Ordered comma-separated AI failover chain   | `gemini,groq` (fails over across configured providers without code edits)                                         |
| `GROQ_API_KEY`                    | Conditional | Groq Cloud API key for independent failover | `gsk_...` (optional for Gemini-only; enable Groq Console Zero Data Retention before production use)               |
| `GROQ_MODEL`                      | Optional    | Groq structured-output model ID             | `openai/gpt-oss-120b`                                                                                             |
| `GROQ_BASE_URL`                   | Optional    | Groq OpenAI-compatible API base URL         | `https://api.groq.com/openai/v1` (`https://` mandatory in production/staging)                                     |
| `GROQ_TIMEOUT_MS`                 | Optional    | Groq HTTP request timeout in ms             | `90000` (90s)                                                                                                     |
| `ASSESSMENT_PROVIDER`             | Optional    | AI provider engine mode                     | `gemini` \| `groq` \| `auto` (`gemini` default runs ordered failover chain `AI_PROVIDER_ORDER`)                   |

> [!NOTE]
> Sessions are stateful and stored in PostgreSQL (`Session` table) via SHA-256 token digests. CSRF tokens are derived dynamically via HMAC-SHA256 from the active session token (`deriveCsrfToken`). No external `SESSION_SECRET` or `CSRF_SECRET` environment variable is required.

### Mandatory Worker Environment Variables (`apps/worker`):

The background worker requires an identical database, storage, SMTP, and crypto configuration:

- `NODE_ENV=production`
- `DATABASE_URL`
- `EMAIL_OUTBOX_ENCRYPTION_KEY`
- `EMAIL_OUTBOX_IDEMPOTENCY_SECRET`
- `STORAGE_DRIVER=s3`
- `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
- `AI_PROVIDER_ORDER=gemini,groq`, `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.6-flash`, `GEMINI_FALLBACK_MODEL=gemini-3.5-flash`, `GEMINI_TIMEOUT_MS=90000`, `GROQ_API_KEY`, `GROQ_MODEL=openai/gpt-oss-120b`, `GROQ_BASE_URL=https://api.groq.com/openai/v1`, `GROQ_TIMEOUT_MS=90000`, `ASSESSMENT_PROVIDER=gemini`

### Multi-Provider AI Failover & Groq Zero Data Retention (ZDR) Governance

TalentLens AI orchestrates JD extraction (`apps/api`) and candidate assessment (`apps/worker`) across an ordered failover chain (`AI_PROVIDER_ORDER`, default `gemini,groq`):

- **Automatic Failover Eligibility:** If a configured provider fails with invalid/unauthorized credentials (`401`/`403`), rate limits/quota exhaustion (`429`), service capacity unavailability (`503`), upstream 5xx/network errors, timeouts, or repeated invalid JSON/schema output, TalentLens automatically records a sanitized failover warning and attempts the next configured provider (`groq` using `openai/gpt-oss-120b` strict JSON Schema structured outputs).
- **Fail-Closed Hard-Stop Rules:** Content-safety/policy blocks (`CONTENT_SAFETY`, Groq `finish_reason=content_filter`, or model refusals) and explicit input-validation rejections (`USER_INPUT_INVALID`, e.g., context-length or payload errors) **never retry or fail over** to another provider.
- **Groq Privacy & Zero Data Retention (ZDR):** Candidate resume assessment prompts contain PII-redacted text (`2026-11-redactor-v2`), while JD extraction sends job descriptions to the active AI vendor. Before enabling `GROQ_API_KEY` on live production or non-synthetic recruitment data, operators **must enable Zero Data Retention (ZDR) / disable data logging and model training in Groq Cloud Console** (`Settings -> Data Controls`), ensuring Groq does not retain prompts or completions after request execution.
- **Live Verification & Deploy Controllers:** Validate providers independently with `npm run test:gemini`, `npm run test:groq`, and `npm run diagnose:jd -- --provider=auto`. For environment orchestration, use `npm run deploy:local` (`-- --dry-run`, `-- --force`) locally and `npm run deploy:production` (default safe dry-run; supports `--remote-env-file ../.env.candidate` or `npm run deploy:production -- ... --env-file ../.env.candidate` guarded by `node --` for remote OCI env files without copying secrets to Windows, and `-- --execute --confirm-production --ssh-host <user@host> --remote-dir <path>` for the 10-stage OCI SSH rollout with pre-rollout `.dump` backup, `.release-previous/` source/Compose snapshot, stale-file clean sync, `--strict-perms`, and `.current-release.json` idempotency) validated by `node --test scripts/deploy-scripts.test.mjs` (24 tests).
- **OCI Server Overlay Requirement (`docker-compose.oci.yml`):** Live OCI deployments running a server-only `docker-compose.oci.yml` must pass `AI_PROVIDER_ORDER`, `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_BASE_URL`, `GROQ_TIMEOUT_MS`, and `ASSESSMENT_PROVIDER` into both `api` and `worker` containers alongside `.env.candidate` before Groq failover is claimed active in live OCI production.

---

## 4. Transactional SMTP Delivery Architecture

Transactional emails (recruiter consent invitations, withdrawal confirmations, client interview scheduling, and feedback notifications) follow an outbox pattern:

1. **API Ingestion**:
   - The API writes an encrypted payload (`encrypted_payload` + `key_id`) into `email_outbox` within the business transaction.
   - Idempotency key is stored as a deterministic HMAC-SHA-256 digest (`createEmailIdempotencyKey`), preventing duplicate dispatch without leaking candidate email addresses.
2. **Worker Dispatch**:
   - The worker claims pending jobs using PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`.
   - The lease duration is governed by PostgreSQL `clock_timestamp()`, immune to server clock skew.
   - The worker establishes a genuine TCP/TLS socket connection using `SmtpClient`.
   - Supports STARTTLS (port 587/25) with mandatory certificate verification (`rejectUnauthorized: true`) or direct TLS (port 465).
   - Authenticates via `AUTH PLAIN` or `AUTH LOGIN`.
3. **Failure Classification**:
   - **4xx Responses** (e.g. 421 Service unavailable, 451 Local error): Classified as transient. Worker applies exponential backoff (1s, 2s, 4s, 8s, up to 60s) up to `max_attempts` (default 3).
   - **5xx Responses** (e.g. 550 User unknown, 535 Auth failed): Classified as permanent. Marked as `PERMANENTLY_REJECTED` immediately with zero retry.
   - On delivery, `sent_at = clock_timestamp()` is recorded, the sensitive payload is cryptographically shredded (`encrypted_payload = NULL`), and the remote MTA queue ID is logged.

---

## 5. Resume Antivirus & Malware Scanning Setup

To defend against malicious documents, zip bombs, and weaponized macros:

1. **Daemon Deployment**:
   - Run the pinned ClamAV daemon image (`clamav/clamav:1.4` in `docker-compose.prod.yml`) listening internally on port `3310`.
   - Ensure virus signatures are automatically updated via `freshclam`.
2. **Streaming Protocol**:
   - Resumes are streamed to `clamd` using the chunked `zINSTREAM\0` TCP protocol (up to 64KB per chunk).
   - Untrusted files never leave the private network (zero candidate resumes are uploaded to external services such as VirusTotal).
3. **Fail-Closed Policy**:
   - `SCANNER_FAIL_CLOSED=true` is enforced in production and staging.
   - If the ClamAV daemon is unreachable, times out, or returns a malformed response, the document is quarantined and rejected (`status: REJECTED`, reason: `Antivirus scanner unavailable; upload quarantined`).
   - Clean documents must receive an explicit `stream: OK\0` before they can be stored in S3 or queued for AI assessment.

---

## 6. Private S3 Object Storage Configuration

All candidate resume PDFs and DOCX files must reside in a private S3 bucket.

### Security Invariants:

1. **Zero Public Access**:
   - Enable S3 Block Public Access on the bucket:
     - `BlockPublicAcls = true`
     - `IgnorePublicAcls = true`
     - `BlockPublicPolicy = true`
     - `RestrictPublicBuckets = true`
2. **Bucket Encryption**:
   - Default encryption: SSE-S3 (`AES256`) or AWS KMS (`aws:kms`).
3. **Opaque Partitioned Keys**:
   - Keys are strictly generated in the format: `YYYY-MM/<uuid>.<ext>` (e.g. `2026-11/4a7f2c8d-3b1e-4c9a-9e1f-8c3b2a1d4e5f.pdf`).
   - Keys never contain candidate names, emails, or original file titles.
   - Path traversal validation rejects any key containing `..`, null bytes, or leading slashes.
4. **No Direct Public URLs**:
   - The application does not issue public object URLs or long-lived presigned URLs.
   - Resume downloads occur strictly through authenticated recruiter routes (`GET /api/v1/requisitions/:requisitionId/resumes/:resumeId/file`) with tenant/role verification and audit logging.

---

## 7. Database Migration & Release Procedure

Database schema changes must NEVER run automatically on every API or Worker replica startup.

### Release Steps:

1. **Pre-Deployment Backup**:
   ```bash
   pg_dump -Fc -v -h <db-host> -U talentlens talentlens > backup-$(date +%Y%m%d%H%M%S).dump
   ```
2. **Apply Migrations via One-Shot Command**:
   ```bash
   # Execute operator migration step:
   npx prisma migrate deploy
   ```
   In containerized deployments, run the migration service in `docker-compose.prod.yml`:
   ```bash
   docker compose -f docker-compose.prod.yml run --rm migration
   ```
3. **Deploy Container Replicas**:
   Start API and Worker containers after migration succeeds:
   ```bash
   docker compose -f docker-compose.prod.yml up -d api worker web
   ```

---

## 8. Backup and Disaster Recovery Expectations

1. **PostgreSQL Database Storage & External Destination**:
   - **Local Stage**: Compressed `.sql.gz` (or `--format custom` `.dump`) PostgreSQL archives generated by `scripts/backup.sh` / `scripts/backup.ps1` (Bash default output directory: `/var/backups/talentlens`; PowerShell default: `backups`) with SHA-256 verification sidecars (`.sha256`) and restrictive host permissions (`chmod 700` directory / `chmod 600` files on POSIX; restricted `icacls` ACLs on Windows). These dump files are compressed SQL/binary archives rather than natively encrypted by `backup.sh`; encrypt dumps out-of-band (for example with KMS-backed SSE or client-side age/GPG encryption) before off-host replication.
   - **Repository Protection**: `./backups/` and all `*.sql`, `*.sql.gz`, `*.sql.gz.sha256`, `*.dump`, and `*.dump.sha256` files are excluded from Git tracking via `.gitignore` and from Docker build contexts via `.dockerignore`. Database dumps must NEVER be committed to source control or baked into image layers.
   - **Recommended External Backup Target**: Replicate checksum-verified dumps off-host to a private OCI Object Storage bucket (for example with 90-day retention rules, server-side encryption, and cross-region replication) outside the VM filesystem.
   - Test restoration regularly into an isolated target database using `scripts/restore.sh --create-target` (or `scripts/restore.ps1 -CreateTarget`). See [deployment.md](../deployment.md) Section F for exact flags.
2. **S3 Object Bucket**:
   - Enable S3 Object Versioning to protect against accidental object deletion.
   - Configure lifecycle rules to transition older objects to S3 Glacier Flexible Retrieval if retention policies require long-term archival.
3. **Keyring Rotation**:
   - When rotating `EMAIL_OUTBOX_ENCRYPTION_KEY`, move the existing key to `EMAIL_OUTBOX_PREVIOUS_KEYS=v0:<previous-hex>` so historical undelivered outbox records can still be decrypted.

---

## 9. Deployment Topology & Scaling Limitations

> [!WARNING]
> **RATE LIMITING DEPLOYMENT CONTRACT (Single-Instance API Constraint)**
>
> The current release of TalentLens AI uses `express-rate-limit` with an in-memory store for:
>
> - Recruiter login rate limiting (`10 requests / 15 minutes`).
> - Candidate consent token inspection (`30 requests / 15 minutes`).
> - Consent accept/decline actions (`15 requests / 15 minutes`).
> - Consent withdrawal requests (`10 requests / 15 minutes`).
>
> **Operational Rule**:
>
> - The API service MUST run as a **single replica** (`replicas: 1`).
> - Running multiple API container replicas without a centralized rate limit store will dilute rate limit quotas across instances, weakening brute-force and credential stuffing protections.
>
> **Future Horizontal Scaling Roadmap**:
>
> - To scale the API horizontally beyond a single container, configure a distributed store (e.g. `rate-limit-redis` backed by a managed Redis cluster) before increasing `replicas > 1`.
> - The Worker service is fully stateless and uses PostgreSQL `SKIP LOCKED`; workers can be scaled horizontally without constraint.
