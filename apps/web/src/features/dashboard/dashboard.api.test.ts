import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fetchLiveDashboardData } from './dashboard.api.js';
import * as clientApi from '../clients/client.api.js';
import * as requisitionApi from '../requisitions/requisition.api.js';
import * as candidateApi from '../candidates/candidate.api.js';
import type { ClientRecord } from '../clients/types.js';
import type { RequisitionRecord } from '../requisitions/types.js';
import type { CandidateSummary } from '../candidates/types.js';

describe('dashboard.api - fetchLiveDashboardData', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockClients: ClientRecord[] = [
    {
      id: 'c1',
      name: 'Apex Financial',
      status: 'ACTIVE',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'c2',
      name: 'Beacon Tech',
      status: 'ACTIVE',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
  ];

  const mockRequisitions: RequisitionRecord[] = [
    {
      id: 'r1',
      clientId: 'c1',
      clientName: 'Apex Financial',
      title: 'Principal Distributed Systems Engineer',
      jdText: 'Distributed consensus and high-throughput systems.',
      status: 'OPEN',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    },
    {
      id: 'r2',
      clientId: 'c2',
      clientName: 'Beacon Tech',
      title: 'Senior Frontend Architect',
      jdText: 'React, TypeScript and microfrontends.',
      status: 'OPEN',
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
    },
  ];

  const mockCandidatesR1Page1: CandidateSummary[] = [
    {
      candidateId: 'cand-1',
      candidateCode: 'CAN-8A4F1D',
      resumeDocumentId: 'doc-1',
      resumeFileName: 'marcus_vance.pdf',
      parseStatus: 'PARSED',
      assessmentId: 'ass-1',
      assessmentStatus: 'COMPLETE', // Canonical Prisma enum
      overallScore: 92,
      coverage: 0.95,
      isComplete: true,
      criteriaCount: 4,
      criteriaMetCount: 4,
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-11-06T01:00:00.000Z',
      isShortlisted: true,
      shortlistedAt: '2026-11-06T02:00:00.000Z',
      submissionId: 'sub-1',
      submissionStatus: 'CLIENT_SHORTLISTED',
      submittedAt: '2026-11-06T03:00:00.000Z',
      lastActivityAt: '2026-11-06T04:00:00.000Z',
    },
    {
      candidateId: 'cand-2',
      candidateCode: 'CAN-7B3E2C',
      resumeDocumentId: 'doc-2',
      resumeFileName: 'sara_chen.pdf',
      parseStatus: 'HELD_FOR_AUTHORIZATION', // Canonical Prisma enum
      assessmentId: null,
      assessmentStatus: null,
      overallScore: null,
      coverage: null,
      isComplete: false,
      criteriaCount: 0,
      criteriaMetCount: 0,
      reviewStatus: 'NOT_REVIEWED',
      reviewedAt: null,
      isShortlisted: false,
      shortlistedAt: null,
      submissionId: null,
      submissionStatus: null,
      submittedAt: null,
      lastActivityAt: '2026-11-06T00:30:00.000Z',
    },
  ];

  const mockCandidatesR1Page2: CandidateSummary[] = [
    {
      candidateId: 'cand-page2',
      candidateCode: 'CAN-9D8E7F',
      resumeDocumentId: 'doc-page2',
      resumeFileName: 'david_kim.pdf',
      parseStatus: 'PARSED',
      assessmentId: 'ass-page2',
      assessmentStatus: 'COMPLETE',
      overallScore: 88,
      coverage: 0.9,
      isComplete: true,
      criteriaCount: 4,
      criteriaMetCount: 3,
      reviewStatus: 'NEEDS_REVIEW', // Canonical Prisma enum
      reviewedAt: '2026-11-06T02:30:00.000Z',
      isShortlisted: false,
      shortlistedAt: null,
      submissionId: null,
      submissionStatus: null,
      submittedAt: null,
      lastActivityAt: '2026-11-06T02:30:00.000Z',
    },
  ];

  const mockCandidatesR2: CandidateSummary[] = [
    {
      candidateId: 'cand-3',
      candidateCode: 'CAN-6C2D1B',
      resumeDocumentId: 'doc-3',
      resumeFileName: 'alex_novak.docx',
      parseStatus: 'PENDING',
      assessmentId: null,
      assessmentStatus: null,
      overallScore: null,
      coverage: null,
      isComplete: false,
      criteriaCount: 0,
      criteriaMetCount: 0,
      reviewStatus: 'NOT_REVIEWED',
      reviewedAt: null,
      isShortlisted: false,
      shortlistedAt: null,
      submissionId: null,
      submissionStatus: null,
      submittedAt: null,
      lastActivityAt: '2026-11-05T22:00:00.000Z',
    },
  ];

  it('aggregates live clients, requisitions, and candidate metrics across multiple pages into DashboardData', async () => {
    vi.spyOn(clientApi, 'listClients').mockResolvedValue(mockClients);
    vi.spyOn(requisitionApi, 'listRequisitions').mockResolvedValue(mockRequisitions);
    vi.spyOn(candidateApi, 'listCandidates').mockImplementation(async (requisitionId, query) => {
      if (requisitionId === 'r1') {
        if ((query?.offset ?? 0) === 0) {
          // First page returns 2 items with total: 3
          return { items: mockCandidatesR1Page1, total: 3 };
        }
        // Second page returns the remaining 1 item
        return { items: mockCandidatesR1Page2, total: 3 };
      }
      if (requisitionId === 'r2') {
        return { items: mockCandidatesR2, total: 1 };
      }
      return { items: [], total: 0 };
    });

    const data = await fetchLiveDashboardData();

    // Requisition r1 aggregated both page 1 and page 2 (total 3 candidates)
    expect(data.requisitions).toHaveLength(2);
    expect(data.requisitions[0]).toEqual({
      id: 'r1',
      title: 'Principal Distributed Systems Engineer',
      clientName: 'Apex Financial',
      status: 'OPEN',
      candidates: 3,
      awaitingReview: 0,
      withClient: 1,
    });

    // Pipeline stages
    const pipelineMap = new Map(data.pipeline.map((p) => [p.key, p.count]));
    expect(pipelineMap.get('new')).toBe(1); // cand-3 (PENDING)
    expect(pipelineMap.get('consent')).toBe(1); // cand-2 (HELD_FOR_AUTHORIZATION)
    expect(pipelineMap.get('client')).toBe(1); // cand-1 (submitted)
    expect(pipelineMap.get('review')).toBe(1); // cand-page2 (NEEDS_REVIEW)

    // Verify all 4 candidates from all pages are present in review queue
    expect(data.reviewQueue).toHaveLength(4);
    const page2Item = data.reviewQueue.find((i) => i.candidateCode === 'CAN-9D8E7F');
    expect(page2Item).toBeDefined();
    expect(page2Item?.score).toBe(88);
    expect(page2Item?.coverage).toBe(90);
    expect(page2Item?.assessmentStatus).toBe('COMPLETE');

    const cand2Item = data.reviewQueue.find((i) => i.candidateCode === 'CAN-7B3E2C');
    expect(cand2Item?.consent).toBe('PENDING'); // HELD_FOR_AUTHORIZATION mapped to PENDING consent
  });

  it('tolerates individual requisition candidate fetch errors gracefully', async () => {
    vi.spyOn(clientApi, 'listClients').mockResolvedValue(mockClients);
    vi.spyOn(requisitionApi, 'listRequisitions').mockResolvedValue(mockRequisitions);
    vi.spyOn(candidateApi, 'listCandidates').mockRejectedValueOnce(
      new Error('Requisition candidate timeout'),
    );

    const data = await fetchLiveDashboardData();

    expect(data.requisitions).toHaveLength(2);
    expect(data.requisitions[0]?.candidates).toBe(0);
  });

  it('strictly derives review metrics only from canonical ReviewDecision values (REVIEWED, NEEDS_REVIEW, CLOSED) and ignores unknown statuses', async () => {
    vi.spyOn(clientApi, 'listClients').mockResolvedValue([mockClients[0]!]);
    vi.spyOn(requisitionApi, 'listRequisitions').mockResolvedValue([mockRequisitions[0]!]);

    const candidatesWithVariousDecisions: CandidateSummary[] = [
      {
        ...mockCandidatesR1Page1[0]!,
        candidateId: 'cand-reviewed',
        candidateCode: 'CAN-REV',
        reviewStatus: 'REVIEWED',
        isShortlisted: false,
        submissionId: null,
        submissionStatus: null,
      },
      {
        ...mockCandidatesR1Page1[0]!,
        candidateId: 'cand-needs-review',
        candidateCode: 'CAN-FLAG',
        reviewStatus: 'NEEDS_REVIEW',
        isShortlisted: false,
        submissionId: null,
        submissionStatus: null,
      },
      {
        ...mockCandidatesR1Page1[0]!,
        candidateId: 'cand-closed',
        candidateCode: 'CAN-CLS',
        reviewStatus: 'CLOSED',
        isShortlisted: false,
        submissionId: null,
        submissionStatus: null,
      },
      {
        ...mockCandidatesR1Page1[0]!,
        candidateId: 'cand-unknown',
        candidateCode: 'CAN-UNK',
        reviewStatus: 'INVALID_STATUS' as unknown as CandidateSummary['reviewStatus'],
        isShortlisted: false,
        submissionId: null,
        submissionStatus: null,
      },
      {
        ...mockCandidatesR1Page1[0]!,
        candidateId: 'cand-unreviewed',
        candidateCode: 'CAN-UNREV',
        reviewStatus: 'NOT_REVIEWED',
        isShortlisted: false,
        submissionId: null,
        submissionStatus: null,
      },
    ];

    vi.spyOn(candidateApi, 'listCandidates').mockResolvedValueOnce({
      items: candidatesWithVariousDecisions,
      total: 5,
    });

    const data = await fetchLiveDashboardData();
    const pipelineMap = new Map(data.pipeline.map((p) => [p.key, p.count]));

    // Strictly 2 active candidates with canonical REVIEWED and NEEDS_REVIEW (excluding CLOSED, unknown, and NOT_REVIEWED)
    expect(pipelineMap.get('review')).toBe(2);

    // Activities only record for valid reviewed candidates
    const reviewActivities = data.activity.filter((a) => a.kind === 'review_recorded');
    expect(reviewActivities).toHaveLength(3);
    const codes = reviewActivities.map((a) => a.summary);
    expect(codes.some((s) => s.includes('CAN-REV'))).toBe(true);
    expect(codes.some((s) => s.includes('CAN-FLAG'))).toBe(true);
    expect(codes.some((s) => s.includes('CAN-CLS'))).toBe(true);
    expect(codes.some((s) => s.includes('CAN-UNK'))).toBe(false);
  });
});
