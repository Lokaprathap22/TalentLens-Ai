# Database Integrity

This document records the relational safeguards added to the TalentLens AI
database foundation. It complements the technical specification without
replacing service-layer authorization, workflow validation, or privacy
controls.

## Tenant isolation

Organization-owned records carry an `organization_id` and use composite
foreign keys where a child also references an organization-scoped record.
The protected relationships include:

- users, clients, candidates, requisitions, resumes, processing batches,
  scorecard versions, assessments, reviews, submissions, decisions, consent
  records, deletion requests, assessment text, extractions, pipeline events,
  and audit records;
- requisition-to-client, creator, recruiter, scorecard, batch, assessment,
  review, and submission relationships;
- candidate-to-resume, profile, identity, assessment, review, submission,
  consent, and deletion relationships; and
- client memberships and client decisions.

The corresponding compound unique keys make the organization part of the
referenced identity. This prevents independently valid IDs from forming a
cross-organization row.

## Assessment privacy boundary

`DocumentExtraction.extractedText` remains the original extraction boundary
for processing and audit purposes. Each extraction has an immutable version
per resume. `AssessmentText.redactedText` is a separate immutable, versioned
assessment input with page mapping and redaction mapping.
The redaction mapping stores positional metadata only; it must not contain
the removed identity values.

Assessment text references the exact resume, organization, and extraction
source through composite foreign keys. Candidate assessments and evidence
snippets use the same four-part assessment-text source key
(`assessmentTextId`, `resumeDocumentId`, `organizationId`,
`documentExtractionId`). This ensures that a different resume, tenant, or
source extraction cannot be attached to historical assessment or evidence
records. Assessment services must accept only redacted assessment text and
must keep name, gender, age/date of birth, photograph,
marital status, and other identity/contact data outside scoring inputs.

## Assessment and submission traceability

`CandidateAssessment` records the exact organization, requisition, candidate,
resume document, scorecard version, and assessment text. Criterion assessments
also carry the scorecard version so a criterion from another scorecard cannot
be attached accidentally.

`CandidateSubmission` records the exact assessment, review, resume document,
candidate, requisition, client, and submitting user. Its requisition
relationship includes requisition, client, and organization, preventing a
submission from naming a different client in the same organization.
Composite relations ensure these references describe the same candidate and
requisition. A submission service must additionally require a completed
assessment, an
approved scorecard, a recruiter review of the current resume, an open
requisition, and active candidate consent.

## Client membership and decisions

`ClientDecision` records the organization, client, submission, acting user,
and the exact `ClientMembership` row. The membership relation prevents a
decision from being attributed to a user who is not a member of the
submission's client.

The service layer must still check that the user is active, the membership is
active, the membership role is `CLIENT_HIRING_MANAGER`, the submission belongs
to that client, and the decision is valid for the current submission state.
Decision reasons, interview timestamps, and time zones remain application
validation concerns.

## Processing and duplicate protection

Processing batches are organization-owned and tied to an organization-scoped
requisition and creator. Processing jobs carry the same organization and
reference organization-scoped batches and resumes. The job uniqueness key
supports idempotent scheduling for a batch, resume, and job type.

Resume hashes are unique within an organization, and candidate resume
versions are unique per candidate. Assessment uniqueness prevents duplicate
assessment rows for the same requisition, candidate, resume, and scorecard
version.

Extraction and redaction versions are unique per resume, while their source
relationships retain the exact organization and resume. New processing or
redaction output must create a new version rather than overwrite a source
used by historical assessments.

Scorecard versions are organization-scoped through their requisition and
their approver uses the same organization-aware user relationship. Pipeline
events use organization-aware candidate, requisition, actor, and optional
submission relations; an optional submission must match the event's
candidate and requisition.

## Consent, deletion, and audit

Consent and deletion records are organization-scoped and retain their
candidate and actor/requester organization relationships. Audit records retain
the organization and use organization-scoped optional resource relationships.
Restrictive deletion actions preserve traceability; deletion workflows must
erase or anonymize permitted personal data while retaining necessary
non-identifying audit history.

Deletion processing remains transactional at the service level: mark the
candidate pending deletion, block new work, cancel processing, delete private
objects, erase or anonymize permitted identity data, and record the outcome.

## Prisma and service-layer limits

Prisma supports the compound unique constraints and compound foreign keys
used here. Prisma does not express every PostgreSQL guarantee in the schema
DSL. A future migration may be needed for partial unique indexes, arbitrary
`CHECK` constraints, append-only audit triggers, row-level security, and
database permissions.

The application must continue to enforce authorization, active statuses,
workflow transitions, consent freshness, current-resume review, evidence
quote verification, redaction correctness, deterministic scoring, client DTO
masking, and protection against instructions embedded in CV or JD content.
No database migration or live database mutation is included in this
foundation change.
