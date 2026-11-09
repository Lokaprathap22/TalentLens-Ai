import { describe, expect, it } from 'vitest';
import { getDatabaseClient } from '@talentlens/database';
import { createWorkflowRepository } from './workflow.repository.js';
import { createWorkflowService } from './workflow.service.js';

const RUN_INTEGRATION = process.env['TALENTLENS_RUN_PG_INTEGRATION'] === '1';

describe.skipIf(!RUN_INTEGRATION)('Global Candidates PostgreSQL Integration Suite', () => {
  it('enforces organization boundary isolation and never exposes other tenants candidates', async () => {
    const db = getDatabaseClient();
    const repo = createWorkflowRepository(db);
    const service = createWorkflowService(repo);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Create Tenant A
    const orgA = await db.organization.create({
      data: {
        name: `Org A ${suffix}`,
        normalizedName: `org-a-${suffix}`,
      },
    });

    const recruiterA = await db.user.create({
      data: {
        organizationId: orgA.id,
        email: `recruiter-a-${suffix}@example.com`,
        normalizedEmail: `recruiter-a-${suffix}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
      },
    });

    // Create Tenant B
    const orgB = await db.organization.create({
      data: {
        name: `Org B ${suffix}`,
        normalizedName: `org-b-${suffix}`,
      },
    });

    const recruiterB = await db.user.create({
      data: {
        organizationId: orgB.id,
        email: `recruiter-b-${suffix}@example.com`,
        normalizedEmail: `recruiter-b-${suffix}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
      },
    });

    // Seed 2 candidates in Org A
    const candA1 = await db.candidate.create({
      data: {
        organizationId: orgA.id,
        candidateCode: `CAN-A1-${suffix.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    const candA2 = await db.candidate.create({
      data: {
        organizationId: orgA.id,
        candidateCode: `CAN-A2-${suffix.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    // Seed 2 candidates in Org B
    const candB1 = await db.candidate.create({
      data: {
        organizationId: orgB.id,
        candidateCode: `CAN-B1-${suffix.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    const candB2 = await db.candidate.create({
      data: {
        organizationId: orgB.id,
        candidateCode: `CAN-B2-${suffix.toUpperCase()}`,
        recordStatus: 'ACTIVE',
      },
    });

    const principalA = {
      userId: recruiterA.id,
      organizationId: orgA.id,
      role: 'RECRUITER' as const,
    };

    const principalB = {
      userId: recruiterB.id,
      organizationId: orgB.id,
      role: 'RECRUITER' as const,
    };

    // Query from Recruiter A
    const resultA = await service.listGlobalCandidates(principalA, {
      page: 1,
      pageSize: 20,
      sortBy: 'activity',
      sortOrder: 'desc',
    });

    // Assert Recruiter A only sees Org A candidates
    const codesA = resultA.items.map((i) => i.candidateCode);
    expect(codesA).toContain(candA1.candidateCode);
    expect(codesA).toContain(candA2.candidateCode);
    expect(codesA).not.toContain(candB1.candidateCode);
    expect(codesA).not.toContain(candB2.candidateCode);
    expect(
      resultA.items.every((i) => i.candidateId === candA1.id || i.candidateId === candA2.id),
    ).toBe(true);

    // Query from Recruiter B
    const resultB = await service.listGlobalCandidates(principalB, {
      page: 1,
      pageSize: 20,
      sortBy: 'activity',
      sortOrder: 'desc',
    });

    // Assert Recruiter B only sees Org B candidates
    const codesB = resultB.items.map((i) => i.candidateCode);
    expect(codesB).toContain(candB1.candidateCode);
    expect(codesB).toContain(candB2.candidateCode);
    expect(codesB).not.toContain(candA1.candidateCode);
    expect(codesB).not.toContain(candA2.candidateCode);
  });

  it('handles pagination across more than 20 candidates, deterministic score sorting, and low-scoring candidate visibility', async () => {
    const db = getDatabaseClient();
    const repo = createWorkflowRepository(db);
    const service = createWorkflowService(repo);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const org = await db.organization.create({
      data: {
        name: `Pagination Org ${suffix}`,
        normalizedName: `pagination-org-${suffix}`,
      },
    });

    const recruiter = await db.user.create({
      data: {
        organizationId: org.id,
        email: `recruiter-${suffix}@example.com`,
        normalizedEmail: `recruiter-${suffix}@example.com`,
        role: 'RECRUITER',
        status: 'ACTIVE',
        passwordHash: 'dummy-hash',
      },
    });

    const client = await db.client.create({
      data: {
        organizationId: org.id,
        name: `Acme ${suffix}`,
        normalizedName: `acme-${suffix}`,
        status: 'ACTIVE',
      },
    });

    const requisition = await db.requisition.create({
      data: {
        organizationId: org.id,
        clientId: client.id,
        createdById: recruiter.id,
        assignedRecruiterId: recruiter.id,
        title: `Backend Architect ${suffix}`,
        jdText: 'JD for backend architect',
        status: 'OPEN',
      },
    });

    const scorecardVersion = await db.scorecardVersion.create({
      data: {
        organizationId: org.id,
        requisitionId: requisition.id,
        version: 1,
        status: 'APPROVED',
        weightsJson: {},
        approvedById: recruiter.id,
        approvedAt: new Date(),
      },
    });

    const principal = {
      userId: recruiter.id,
      organizationId: org.id,
      role: 'RECRUITER' as const,
    };

    // Seed 25 candidates:
    // 5 assessed with different scores (95, 80, 65, 40, 15)
    // 10 awaiting assessment
    // 10 needs review
    const seededCandidateIds: string[] = [];
    const testScores = [95, 80, 65, 40, 15];

    for (let i = 0; i < 25; i++) {
      const code = `CAN-${suffix.toUpperCase()}-${String(i).padStart(2, '0')}`;
      const cand = await db.candidate.create({
        data: {
          organizationId: org.id,
          candidateCode: code,
          recordStatus: 'ACTIVE',
        },
      });
      seededCandidateIds.push(cand.id);

      // Create a resume document
      const resume = await db.resumeDocument.create({
        data: {
          organizationId: org.id,
          candidateId: cand.id,
          objectKey: `resumes/${cand.id}/resume_${i}.pdf`,
          sha256: `dummy-sha256-${i}-${suffix}`,
          mimeType: 'application/pdf',
          fileType: 'PDF',
          sizeBytes: BigInt(1024),
          version: 1,
          parseStatus: i < 5 ? 'PARSED' : i < 15 ? 'PENDING' : 'NEEDS_REVIEW',
          uploadedById: recruiter.id,
        },
      });

      // Create batch and processing job linking resume to requisition
      const batch = await db.processingBatch.create({
        data: {
          organizationId: org.id,
          requisitionId: requisition.id,
          createdById: recruiter.id,
          totalFiles: 1,
          status: 'COMPLETED',
        },
      });

      await db.processingJob.create({
        data: {
          organizationId: org.id,
          batchId: batch.id,
          resumeDocumentId: resume.id,
          jobType: 'EXTRACT_TEXT',
          status: 'SUCCEEDED',
        },
      });

      // Add profile info for some candidates
      if (i === 0) {
        await db.candidateProfile.create({
          data: {
            organizationId: org.id,
            candidateId: cand.id,
            currentRole: 'Principal Cloud Architect',
            experienceYears: 12,
            location: 'San Francisco, CA',
            profileVersion: 1,
            skills: {
              create: [
                { skillNameNormalized: 'cloud architecture' },
                { skillNameNormalized: 'kubernetes' },
              ],
            },
          },
        });
      }

      // Add assessment for the first 5 candidates
      if (i < 5) {
        const docExt = await db.documentExtraction.create({
          data: {
            organizationId: org.id,
            resumeDocumentId: resume.id,
            version: 1,
            extractedText: 'Sample extracted resume text',
            pageMapJson: {},
            parser: 'pdf-parse',
            qualityStatus: 'COMPLETE',
          },
        });

        const assessText = await db.assessmentText.create({
          data: {
            organizationId: org.id,
            resumeDocumentId: resume.id,
            documentExtractionId: docExt.id,
            version: 1,
            redactedText: 'Sample redacted text',
            pageMapJson: {},
            redactionMapJson: {},
            redactorVersion: 'v1.0',
          },
        });

        await db.candidateAssessment.create({
          data: {
            organizationId: org.id,
            requisitionId: requisition.id,
            candidateId: cand.id,
            resumeDocumentId: resume.id,
            documentExtractionId: docExt.id,
            scorecardVersionId: scorecardVersion.id,
            assessmentTextId: assessText.id,
            status: 'COMPLETE',
            score: testScores[i]!,
            coverage: 1.0,
            formulaVersion: 'v1.0',
            modelMetadataJson: {},
          },
        });
      }
    }

    // 1. Pagination across more than 20 candidates (page 1 of 15, page 2 of 15)
    const page1 = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 15,
      sortBy: 'activity',
      sortOrder: 'desc',
    });

    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    expect(page1.pageSize).toBe(15);
    expect(page1.totalPages).toBe(2);
    expect(page1.items).toHaveLength(15);

    const page2 = await service.listGlobalCandidates(principal, {
      page: 2,
      pageSize: 15,
      sortBy: 'activity',
      sortOrder: 'desc',
    });

    expect(page2.total).toBe(25);
    expect(page2.page).toBe(2);
    expect(page2.items).toHaveLength(10);

    // Verify deterministic separation: no duplicate candidates across pages
    const page1Ids = new Set(page1.items.map((i) => i.candidateId));
    for (const item of page2.items) {
      expect(page1Ids.has(item.candidateId)).toBe(false);
    }

    // 2. Deterministic score sorting & low-scoring candidate visibility
    const scoreSorted = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      sortBy: 'score',
      sortOrder: 'desc',
    });

    // The first 5 items must be the assessed candidates with scores sorted descending
    const returnedScores = scoreSorted.items.slice(0, 5).map((i) => i.overallScore);
    expect(returnedScores).toEqual([95, 80, 65, 40, 15]);

    // Low-scoring candidate (15%) is strictly preserved and not rejected or hidden
    const lowScorer = scoreSorted.items.find((i) => i.overallScore === 15);
    expect(lowScorer).toBeDefined();
    expect(lowScorer?.statusCategory).toBe('ASSESSED');

    // Remaining 20 candidates have null score
    const unassessed = scoreSorted.items.slice(5);
    expect(unassessed.every((i) => i.overallScore === null)).toBe(true);

    // 3. Status category filter: ASSESSED
    const assessedOnly = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      statusCategory: 'ASSESSED',
      sortBy: 'activity',
      sortOrder: 'desc',
    });
    expect(assessedOnly.total).toBe(5);
    expect(assessedOnly.items.every((i) => i.statusCategory === 'ASSESSED')).toBe(true);

    // 4. Status category filter: NEEDS_REVIEW
    const needsReviewOnly = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      statusCategory: 'NEEDS_REVIEW',
      sortBy: 'activity',
      sortOrder: 'desc',
    });
    expect(needsReviewOnly.total).toBe(10);
    expect(needsReviewOnly.items.every((i) => i.statusCategory === 'NEEDS_REVIEW')).toBe(true);

    // 5. Status category filter: AWAITING_ASSESSMENT
    const awaitingOnly = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      statusCategory: 'AWAITING_ASSESSMENT',
      sortBy: 'activity',
      sortOrder: 'desc',
    });
    expect(awaitingOnly.total).toBe(10);
    expect(awaitingOnly.items.every((i) => i.statusCategory === 'AWAITING_ASSESSMENT')).toBe(true);

    // 6. Search by candidate profile role
    const searchResult = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      search: 'Cloud Architect',
      sortBy: 'activity',
      sortOrder: 'desc',
    });
    expect(searchResult.total).toBe(1);
    expect(searchResult.items[0]?.currentRole).toBe('Principal Cloud Architect');

    // 7. Requisition filter
    const reqFiltered = await service.listGlobalCandidates(principal, {
      page: 1,
      pageSize: 25,
      requisitionId: requisition.id,
      sortBy: 'activity',
      sortOrder: 'desc',
    });
    expect(reqFiltered.total).toBe(25);
    expect(reqFiltered.items.every((i) => i.requisitionId === requisition.id)).toBe(true);
  });
});
