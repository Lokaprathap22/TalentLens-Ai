-- Migration: 20261106140000_email_outbox_quarantine_legacy
-- Quarantine legacy unencrypted pending records and purge plaintext from terminal states

UPDATE "email_outbox"
SET "status" = 'FAILED',
    "last_error_code" = 'QUARANTINED_UNENCRYPTED_LEGACY',
    "last_error" = 'Legacy unencrypted record quarantined to prevent raw token exposure',
    "html" = '[PURGED]',
    "text" = '[PURGED]',
    "recipient_email" = NULL,
    "subject" = NULL
WHERE "status" IN ('PENDING', 'SENDING') AND "encrypted_payload" IS NULL;

UPDATE "email_outbox"
SET "html" = '[PURGED]',
    "text" = '[PURGED]',
    "recipient_email" = NULL,
    "subject" = NULL
WHERE "status" IN ('SENT', 'FAILED', 'PERMANENTLY_REJECTED') AND "encrypted_payload" IS NULL;

