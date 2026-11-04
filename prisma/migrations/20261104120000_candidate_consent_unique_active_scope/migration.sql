-- Clean up any existing duplicate historical ACTIVE records for the same candidate and requisition scope
-- by transitioning older records to EXPIRED, preserving the latest record as ACTIVE.
UPDATE "candidate_consents" c1
SET "status" = 'EXPIRED', "updated_at" = NOW()
WHERE c1."status" = 'ACTIVE'
  AND c1."requisition_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "candidate_consents" c2
    WHERE c2."organization_id" = c1."organization_id"
      AND c2."candidate_id" = c1."candidate_id"
      AND c2."requisition_id" = c1."requisition_id"
      AND c2."purpose" = c1."purpose"
      AND c2."status" = 'ACTIVE'
      AND (
        c2."captured_at" > c1."captured_at"
        OR (c2."captured_at" = c1."captured_at" AND c2."id" > c1."id")
      )
  );

-- Create partial unique index ensuring only at most ONE active consent can exist
-- for any (organization_id, candidate_id, requisition_id, purpose) tuple.
CREATE UNIQUE INDEX IF NOT EXISTS "candidate_consents_active_scope_unique_idx"
ON "candidate_consents" ("organization_id", "candidate_id", "requisition_id", "purpose")
WHERE "status" = 'ACTIVE' AND "requisition_id" IS NOT NULL;
