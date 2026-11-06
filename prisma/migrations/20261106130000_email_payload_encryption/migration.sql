-- AlterTable
ALTER TABLE "email_outbox" ADD COLUMN "encrypted_payload" TEXT;
ALTER TABLE "email_outbox" ADD COLUMN "key_id" TEXT;
ALTER TABLE "email_outbox" ALTER COLUMN "recipient_email" DROP NOT NULL;
ALTER TABLE "email_outbox" ALTER COLUMN "subject" DROP NOT NULL;
ALTER TABLE "email_outbox" ALTER COLUMN "html" DROP NOT NULL;
ALTER TABLE "email_outbox" ALTER COLUMN "text" DROP NOT NULL;

-- Backfill / purge historical plaintext bodies from previously delivered records
UPDATE "email_outbox"
SET "html" = '[PURGED]',
    "text" = '[PURGED]'
WHERE "status" = 'SENT'
  AND "encrypted_payload" IS NULL;

