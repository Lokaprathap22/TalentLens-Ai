-- AlterTable
ALTER TABLE "processing_batches" ADD COLUMN IF NOT EXISTS "cumulative_bytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "processing_batches" ADD COLUMN IF NOT EXISTS "is_open" BOOLEAN NOT NULL DEFAULT true;

