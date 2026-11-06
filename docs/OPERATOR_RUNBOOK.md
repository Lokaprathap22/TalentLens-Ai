# TalentLens AI — Production Operations & Deployment Runbook

This document is the operational guide for deploying, provisioning, and maintaining the TalentLens AI recruitment SaaS platform in production and staging environments.

---

## 1. Initial Organization & Recruiter Provisioning

TalentLens AI enforces strict multi-tenancy and does not allow unauthenticated public sign-ups or default hard-coded administrator credentials.

### Secure CLI Bootstrap Procedure

To provision the first tenant organization and the initial active recruiter account:

```bash
# From repository root or apps/api directory:
npm run bootstrap --workspace @talentlens/api -- "Enterprise Client Name" "recruiter.admin@client.com"
```

### Operational Characteristics:

- **Random Entropy**: Generates an 18-byte URL-safe base64 string (~144 bits of cryptographic entropy) for one-time initial login.
- **Argon2id Hashing**: Hashes password using argon2id (`memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`, `hashLength: 32`).
- **Normalized Multi-Tenant Collision Check**: Normalizes organization name (`normalized_name`) and email (`normalized_email`), preventing duplicate collision.
- **Mandatory First-Login Rotation**: The operator must record the generated password and deliver it via an encrypted channel (e.g. 1Password/Bitwarden). The recruiter must change their password upon first sign-in.

---

## 2. Production Secret Generation

Every production secret must be generated with cryptographically strong pseudo-random number generators. Never reuse keys between staging and production.

```bash
# 1. Dedicated AES-256-GCM Email Outbox Payload Encryption Key (exactly 32 bytes / 64 hex chars)
openssl rand -hex 32
# Set as: EMAIL_OUTBOX_ENCRYPTION_KEY=<generated-hex-string>

# 2. Dedicated HMAC-SHA-256 Secret for Email Idempotency Keys (at least 32 bytes / 64 hex chars)
openssl rand -hex 32
# Set as: EMAIL_OUTBOX_IDEMPOTENCY_SECRET=<generated-hex-string>

# 3. Session Signing Secret (at least 32 bytes / 64 hex chars)
openssl rand -hex 32
# Set as: SESSION_SECRET=<generated-hex-string>

# 4. PostgreSQL Database Password
openssl rand -base64 32
```

> [!CAUTION]
> `EMAIL_OUTBOX_ENCRYPTION_KEY` and `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` must be completely independent secrets.
> Do NOT use the same string for both variables. Both API and Worker must share the exact same keys.

---

## 3. Environment Configuration

### Mandatory API Environment Variables (`apps/api`):

| Variable                          | Required | Description                              | Example / Notes                                            |
| :-------------------------------- | :------- | :--------------------------------------- | :--------------------------------------------------------- |
| `NODE_ENV`                        | Yes      | Deployment environment mode              | `production` or `staging`                                  |
| `PORT`                            | Yes      | HTTP listening port                      | `3000`                                                     |
| `DATABASE_URL`                    | Yes      | PostgreSQL connection string             | `postgresql://user:pass@postgres:5432/talentlens`          |
| `APP_ORIGIN`                      | Yes      | Strict client origin for CSRF & CORS     | `https://app.talentlens.ai` (no trailing slash/path)       |
| `EMAIL_OUTBOX_ENCRYPTION_KEY`     | Yes      | Primary AES-256-GCM key for outbox       | 64-char hex string (32 bytes)                              |
| `EMAIL_OUTBOX_IDEMPOTENCY_SECRET` | Yes      | HMAC key for deterministic outbox hashes | 64-char hex string (32 bytes)                              |
| `STORAGE_DRIVER`                  | Yes      | Resume storage adapter                   | `s3` (mandatory in staging/production)                     |
| `S3_BUCKET`                       | Yes      | Private S3 bucket name                   | `talentlens-resumes-prod`                                  |
| `S3_REGION`                       | Yes      | AWS S3 region                            | `us-east-1`                                                |
| `S3_ACCESS_KEY_ID`                | Yes      | IAM access key with S3 read/write        | `AKIA...`                                                  |
| `S3_SECRET_ACCESS_KEY`            | Yes      | IAM secret key                           | Secret string                                              |
| `SCANNER_DRIVER`                  | Yes      | Antivirus scanner driver                 | `clamav`                                                   |
| `CLAMAV_HOST`                     | Yes      | ClamAV daemon hostname                   | `clamav` (or IP)                                           |
| `CLAMAV_PORT`                     | Yes      | ClamAV daemon TCP port                   | `3310`                                                     |
| `SCANNER_FAIL_CLOSED`             | Yes      | Reject uploads if scanner unreachable    | `true`                                                     |
| `SMTP_HOST`                       | Yes      | Transactional SMTP server hostname       | `smtp.mailgun.org` or `email-smtp.us-east-1.amazonaws.com` |
| `SMTP_PORT`                       | Yes      | SMTP port (587 STARTTLS or 465 SSL)      | `587`                                                      |
| `SMTP_USER`                       | Optional | SMTP authentication username             | `postmaster@talentlens.ai`                                 |
| `SMTP_PASS`                       | Optional | SMTP authentication password             | Password string                                            |
| `EMAIL_FROM`                      | Yes      | Default sender address                   | `notifications@talentlens.ai`                              |

> [!NOTE]
> Sessions are stateful and stored in PostgreSQL (`Session` table) via SHA-256 token digests. CSRF tokens are derived dynamically via HMAC-SHA256 from the active session token (`deriveCsrfToken`). No external `SESSION_SECRET` or `CSRF_SECRET` environment variable is required.

### Mandatory Worker Environment Variables (`apps/worker`):

The background worker requires an identical database, storage, SMTP, and crypto configuration:

- `NODE_ENV=production`
- `DATABASE_URL`
- `EMAIL_OUTBOX_ENCRYPTION_KEY`
- `EMAIL_OUTBOX_IDEMPOTENCY_SECRET`
- `STORAGE_DRIVER=s3`
- `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`

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
   - Run ClamAV daemon (`clamav/clamav:latest`) listening on port 3310.
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
   - Resume downloads occur strictly through authenticated recruiter routes (`GET /api/resumes/:id/original`) with role verification and audit logging.

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

1. **PostgreSQL Database**:
   - Configure continuous archiving (WAL archiving) and automated daily snapshots.
   - Test restoration procedure quarterly into an isolated test instance.
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
