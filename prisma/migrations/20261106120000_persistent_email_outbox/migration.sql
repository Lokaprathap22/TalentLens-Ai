-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'PERMANENTLY_REJECTED');

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "message_type" TEXT NOT NULL,
    "recipient_email" TEXT NOT NULL,
    "recipient_role" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "payload_json" JSONB,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_attempt_at" TIMESTAMP(3),
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "last_error_code" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotency_key_key" ON "email_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_outbox_status_next_attempt_at_idx" ON "email_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "email_outbox_status_lease_expires_at_idx" ON "email_outbox"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "email_outbox_recipient_email_idx" ON "email_outbox"("recipient_email");

-- CreateIndex
CREATE INDEX "email_outbox_organization_id_created_at_idx" ON "email_outbox"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

