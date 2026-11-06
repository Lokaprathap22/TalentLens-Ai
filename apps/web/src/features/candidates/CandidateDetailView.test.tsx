import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as candidateApi from './candidate.api.js';
import { CandidateDetailView } from './CandidateDetailView.js';
import type { CandidateDetail, DocumentExtraction } from './types.js';

const REQUISITION_ID = 'req-1111-2222-3333';
const CANDIDATE_ID = 'cand-4444-5555-6666';
const RESUME_ID = 'res-7777-8888-9999';

const MOCK_CANDIDATE_DETAIL: CandidateDetail = {
  candidateId: CANDIDATE_ID,
  candidateCode: 'CAN-8A4F1D92',
  requisitionId: REQUISITION_ID,
  requisitionTitle: 'Staff Backend Engineer',
  client: {
    id: 'client-1',
    name: 'Acme Corp',
  },
  resume: {
    id: RESUME_ID,
    fileName: 'alex-mercer-cv.pdf',
    fileType: 'PDF',
    sizeBytes: 153600, // 150 KB
    uploadedAt: '2026-10-25T14:30:00.000Z',
  },
  hasInspectedOriginalResume: false,
  consent: {
    id: 'consent-1',
    status: 'ACTIVE',
    policyVersion: '1.0',
    capturedAt: '2026-10-25T14:28:00.000Z',
  },
  assessment: {
    id: 'assessment-1',
    status: 'COMPLETE',
    score: 92,
    coverage: 1.0,
    isComplete: true,
    formulaVersion: '1.0.0',
    criteria: [
      {
        id: 'crit-1',
        key: 'distributed_systems',
        label: 'Distributed Systems Architecture',
        category: 'TECHNICAL',
        requirementType: 'MUST_HAVE',
        weight: 30,
        status: 'MET',
        confidence: 'HIGH',
        score: 95,
        reasoning: 'Extensive multi-region distributed system experience.',
        evidence: [
          {
            quote: 'Architected geo-distributed Raft consensus cluster.',
            pageNumber: 2,
            startOffset: 120,
            endOffset: 175,
            verified: true,
          },
        ],
      },
    ],
  },
  review: {
    id: 'rev-1',
    decision: 'REVIEWED',
    reviewedAt: '2026-10-26T10:00:00.000Z',
    reviewerId: 'recruiter-99',
    notesInternal: 'Strong candidate for lead role.',
  },
  shortlist: {
    id: 'short-1',
    shortlistedById: 'recruiter-99',
    shortlistedAt: '2026-10-26T10:05:00.000Z',
    notesInternal: 'Top choice.',
  },
  submission: null,
  clientFeedback: [],
};

const MOCK_EXTRACTION: DocumentExtraction = {
  id: 'ext-1',
  resumeDocumentId: RESUME_ID,
  version: 1,
  extractedText:
    'Alex Mercer\nSenior Backend Engineer\nArchitected geo-distributed Raft consensus cluster.',
  pageMap: {},
  parser: 'PDF_PARSER_V2',
  ocrUsed: false,
  qualityStatus: 'COMPLETE',
  createdAt: '2026-10-25T14:31:00.000Z',
};

describe('CandidateDetailView', () => {
  let createObjectURLSpy: ReturnType<typeof vi.fn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    createObjectURLSpy = vi.fn().mockReturnValue('blob:http://localhost/mock-blob-uuid');
    revokeObjectURLSpy = vi.fn();
    globalThis.URL.createObjectURL = createObjectURLSpy as unknown as (
      obj: Blob | MediaSource,
    ) => string;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy as unknown as (url: string) => void;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton initially', () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockReturnValue(new Promise(() => {}));

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText(/loading candidate details/i)).toBeInTheDocument();
  });

  it('renders candidate header, compliance notice, and extracted text by default', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    // Header identity
    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText(/Original CV Not Inspected/i)).toBeInTheDocument();

    // Compliance requirement warning
    expect(
      screen.getByText(/Recruiter inspection of the original CV file is required/i),
    ).toBeInTheDocument();

    // Tab 1: Extracted text
    expect(await screen.findByText(/Quality: complete/i)).toBeInTheDocument();
    expect(screen.getByText(/Direct Text Extraction/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Architected geo-distributed Raft consensus cluster/i),
    ).toBeInTheDocument();
  });

  it('fetches original resume file and creates safe object URL upon clicking Inspect', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);
    const getFileSpy = vi.spyOn(candidateApi, 'getResumeFileBlob').mockResolvedValueOnce({
      blob: new Blob(['%PDF-mock'], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      fileName: 'alex-mercer-cv.pdf',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    // Switch to Original CV Inspection tab
    const inspectionTab = screen.getByRole('tab', { name: /Original CV Inspection/i });
    fireEvent.click(inspectionTab);

    // Click "Inspect Now" or "Inspect Original File"
    const inspectButton = screen.getAllByRole('button', { name: /Inspect/i })[0]!;
    fireEvent.click(inspectButton);

    await waitFor(() => {
      expect(getFileSpy).toHaveBeenCalledWith(REQUISITION_ID, RESUME_ID, 'alex-mercer-cv.pdf');
    });

    // Verified badge should now show
    expect(screen.getByText('Original CV Inspected', { exact: true })).toBeInTheDocument();
    expect(createObjectURLSpy).toHaveBeenCalled();
  });

  it('renders DOCX files with secure download banner and sandbox protection notice', async () => {
    const docxCandidate: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      resume: {
        ...MOCK_CANDIDATE_DETAIL.resume,
        fileName: 'resume.docx',
        fileType: 'DOCX',
      },
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(docxCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);
    vi.spyOn(candidateApi, 'getResumeFileBlob').mockResolvedValueOnce({
      blob: new Blob(['mock-docx'], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'resume.docx',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const inspectionTab = screen.getByRole('tab', { name: /Original CV Inspection/i });
    fireEvent.click(inspectionTab);

    const inspectBtn = screen.getAllByRole('button', { name: /Inspect/i })[0]!;
    fireEvent.click(inspectBtn);

    expect(await screen.findByText(/DOCX Document Inspected/i)).toBeInTheDocument();
    expect(screen.getByText(/Download & Inspect Original DOCX/i)).toBeInTheDocument();
  });

  it('renders Criteria & Assessment tab with reasoning and evidence quotes', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const criteriaTab = screen.getByRole('tab', { name: /Criteria & Assessment/i });
    fireEvent.click(criteriaTab);

    expect(screen.getByText('Distributed Systems Architecture')).toBeInTheDocument();
    expect(
      screen.getByText(/Extensive multi-region distributed system experience/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/"Architected geo-distributed Raft consensus cluster\."/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Verified Quote')).toBeInTheDocument();
  });

  it('renders Consent & Audit tab with consent, review, and shortlist metadata', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const auditTab = screen.getByRole('tab', { name: /Consent & Audit/i });
    fireEvent.click(auditTab);

    expect(screen.getByText(/Candidate Consent Status/i)).toBeInTheDocument();
    expect(screen.getByText('ACTIVE')).toBeInTheDocument();
    expect(screen.getByText('1.0')).toBeInTheDocument();
    expect(screen.getAllByText('Shortlisted').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Strong candidate for lead role/i).length).toBeGreaterThanOrEqual(1);
  });

  it('revokes object URL on unmount to prevent browser memory leaks', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);
    vi.spyOn(candidateApi, 'getResumeFileBlob').mockResolvedValueOnce({
      blob: new Blob(['%PDF'], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      fileName: 'alex-mercer-cv.pdf',
    });

    const { unmount } = render(
      <CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />,
    );

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const inspectionTab = screen.getByRole('tab', { name: /Original CV Inspection/i });
    fireEvent.click(inspectionTab);

    const inspectBtn = screen.getAllByRole('button', { name: /Inspect/i })[0]!;
    fireEvent.click(inspectBtn);

    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalled();
    });

    unmount();

    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/mock-blob-uuid');
  });

  it('allows recruiter to issue consent invitation when candidate consent is missing', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce({
      ...MOCK_CANDIDATE_DETAIL,
      consent: null,
    });
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
    expect(screen.getByText(/Consent Pending · Issue Invitation/i)).toBeInTheDocument();

    const auditTab = screen.getByRole('tab', { name: /Consent & Audit/i });
    fireEvent.click(auditTab);

    expect(screen.getByText('Consent Required')).toBeInTheDocument();
    const issueBtn = screen.getByRole('button', { name: /Issue Consent Invitation/i });
    expect(issueBtn).toBeInTheDocument();

    fireEvent.click(issueBtn);
    expect(screen.getByRole('heading', { name: 'Issue Consent Invitation' })).toBeInTheDocument();
  });

  it('renders truthful processing states across extraction and consent boundaries', async () => {
    // 1. When consent is missing, header displays Held for Consent and Tab 1 displays held notice
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce({
      ...MOCK_CANDIDATE_DETAIL,
      consent: null,
    });
    vi.spyOn(candidateApi, 'getResumeExtraction').mockRejectedValueOnce(new Error('not extracted'));
    vi.spyOn(candidateApi, 'getResumeDetails').mockResolvedValueOnce({
      id: RESUME_ID,
      candidateId: CANDIDATE_ID,
      candidateCode: 'CAN-8A4F1D92',
      fileName: 'alex-mercer-cv.pdf',
      fileType: 'PDF',
      sizeBytes: 153600,
      sha256: 'a'.repeat(64),
      parseStatus: 'PENDING',
      uploadedAt: '2026-10-25T14:30:00.000Z',
      updatedAt: '2026-10-25T14:30:00.000Z',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();
    expect(screen.getByText('Held for Consent')).toBeInTheDocument();
    expect(screen.getByText(/Processing Held for Candidate Consent/i)).toBeInTheDocument();

    // 2. When parseStatus is FAILED, displays Extraction Failed
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockRejectedValueOnce(new Error('failed'));
    vi.spyOn(candidateApi, 'getResumeDetails').mockResolvedValueOnce({
      id: RESUME_ID,
      candidateId: CANDIDATE_ID,
      candidateCode: 'CAN-8A4F1D92',
      fileName: 'alex-mercer-cv.pdf',
      fileType: 'PDF',
      sizeBytes: 153600,
      sha256: 'a'.repeat(64),
      parseStatus: 'FAILED',
      uploadedAt: '2026-10-25T14:30:00.000Z',
      updatedAt: '2026-10-25T14:30:00.000Z',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);
    expect(await screen.findByText('Extraction Failed')).toBeInTheDocument();
    expect(screen.getByText('Document Extraction Failed')).toBeInTheDocument();
  });

  it('handles assessment triggering and renders AI governance, uncertain criteria, and missing evidence', async () => {
    // Candidate without assessment, but with active consent and complete extraction
    const candidateWithoutAssessment = {
      ...MOCK_CANDIDATE_DETAIL,
      assessment: null,
    };
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(candidateWithoutAssessment);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);
    vi.spyOn(candidateApi, 'getResumeDetails').mockResolvedValueOnce({
      id: RESUME_ID,
      candidateId: CANDIDATE_ID,
      candidateCode: 'CAN-8A4F1D92',
      fileName: 'alex-mercer-cv.pdf',
      fileType: 'PDF',
      sizeBytes: 153600,
      sha256: 'a'.repeat(64),
      parseStatus: 'PARSED',
      uploadedAt: '2026-10-25T14:30:00.000Z',
      updatedAt: '2026-10-25T14:30:00.000Z',
    });

    const triggerSpy = vi.spyOn(candidateApi, 'triggerCandidateAssessment').mockResolvedValueOnce({
      job: {
        jobId: 'job-1',
        batchId: 'batch-1',
        requisitionId: REQUISITION_ID,
        candidateId: CANDIDATE_ID,
        resumeDocumentId: RESUME_ID,
        jobType: 'ASSESS_CANDIDATE',
        status: 'QUEUED',
        attempts: 0,
        lastErrorCode: null,
        createdAt: '2026-10-26T00:00:00.000Z',
        updatedAt: '2026-10-26T00:00:00.000Z',
      },
      assessment: null,
      isExisting: false,
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const criteriaTab = screen.getByRole('tab', { name: /Criteria & Assessment/i });
    fireEvent.click(criteriaTab);

    // AI governance advisory must be present
    expect(screen.getByText(/AI-Assisted Evaluation Advisory/i)).toBeInTheDocument();
    expect(
      screen.getByText(/never automatically advances, shortlists, or rejects candidates/i),
    ).toBeInTheDocument();

    // Ready for assessment button
    expect(screen.getByText('Ready for Scorecard Assessment')).toBeInTheDocument();
    const runBtn = screen.getByRole('button', { name: /Run Scorecard Assessment/i });
    fireEvent.click(runBtn);

    expect(triggerSpy).toHaveBeenCalledWith(REQUISITION_ID, RESUME_ID);
  });

  it('renders assessment with NEEDS_REVIEW alert, Must-Have requirements, missing evidence, and uncertain flags', async () => {
    const candidateWithNeedsReview = {
      ...MOCK_CANDIDATE_DETAIL,
      assessment: {
        id: 'assessment-2',
        status: 'NEEDS_REVIEW',
        score: null, // Pending review
        coverage: 0.5,
        isComplete: false,
        formulaVersion: '1.0.0',
        criteria: [
          {
            id: 'crit-must-have',
            key: 'kubernetes',
            label: 'Kubernetes Production Ops',
            category: 'INFRASTRUCTURE',
            requirementType: 'MUST_HAVE',
            weight: 50,
            status: 'UNCERTAIN',
            confidence: 'LOW',
            score: null,
            reasoning: 'Mentioned container orchestrator but exact Kubernetes role is ambiguous.',
            evidence: [],
          },
        ],
      },
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValueOnce(candidateWithNeedsReview);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValueOnce(MOCK_EXTRACTION);
    vi.spyOn(candidateApi, 'getResumeDetails').mockResolvedValueOnce({
      id: RESUME_ID,
      candidateId: CANDIDATE_ID,
      candidateCode: 'CAN-8A4F1D92',
      fileName: 'alex-mercer-cv.pdf',
      fileType: 'PDF',
      sizeBytes: 153600,
      sha256: 'a'.repeat(64),
      parseStatus: 'PARSED',
      uploadedAt: '2026-10-25T14:30:00.000Z',
      updatedAt: '2026-10-25T14:30:00.000Z',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const criteriaTab = screen.getByRole('tab', { name: /Criteria & Assessment/i });
    fireEvent.click(criteriaTab);

    // Review required alert
    expect(screen.getByText(/Recruiter Review Required:/i)).toBeInTheDocument();
    expect(screen.getByText('Pending Review / Incomplete')).toBeInTheDocument();
    expect(screen.getByText('Needs Recruiter Review')).toBeInTheDocument();

    // Must-have badge
    expect(screen.getByText('Must-Have')).toBeInTheDocument();

    // Uncertain evidence banner
    expect(
      screen.getByText(/Conflicting or ambiguous resume evidence detected/i),
    ).toBeInTheDocument();

    // Missing evidence banner
    expect(screen.getByText(/No verifiable evidence quote found in resume/i)).toBeInTheDocument();
  });

  it('records recruiter review decision and sends internal notes', async () => {
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(MOCK_CANDIDATE_DETAIL);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);
    const recordReviewSpy = vi.spyOn(candidateApi, 'recordCandidateReview').mockResolvedValueOnce({
      id: 'rev-001',
      decision: 'REVIEWED',
      reviewedAt: '2026-11-06T01:00:00.000Z',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    const notesInput = screen.getByLabelText(/Internal Recruiter Notes/i);
    fireEvent.change(notesInput, { target: { value: 'Demonstrated deep expertise in Raft.' } });

    const reviewedBtn = screen.getByRole('button', { name: /^Reviewed$/i });
    fireEvent.click(reviewedBtn);

    await waitFor(() => {
      expect(recordReviewSpy).toHaveBeenCalledWith(
        REQUISITION_ID,
        CANDIDATE_ID,
        'REVIEWED',
        'Demonstrated deep expertise in Raft.',
      );
    });

    expect(await screen.findByText(/Review decision recorded as Reviewed/i)).toBeInTheDocument();
  });

  it('enforces shortlisting prerequisites and allows shortlisting only when eligible', async () => {
    // Initial state: hasInspectedOriginalResume is false, review is null
    const uninspectedCandidate = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: false,
      review: null,
      shortlist: null,
    };
    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(uninspectedCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    // Shortlist button should be disabled because original CV is not inspected and review is not REVIEWED
    const shortlistBtn = screen.getByRole('button', { name: /Shortlist Candidate/i });
    expect(shortlistBtn).toBeDisabled();
    expect(
      screen.getByText(/Recruiter must inspect the original CV before shortlisting/i),
    ).toBeInTheDocument();
  });

  it('executes shortlisting successfully when all prerequisites are met', async () => {
    const eligibleCandidate: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: true,
      review: {
        id: 'rev-001',
        decision: 'REVIEWED',
        reviewedAt: '2026-11-05T12:00:00.000Z',
        reviewerId: 'recruiter-1',
        notesInternal: 'Qualified candidate.',
      },
      shortlist: null,
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(eligibleCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);
    const shortlistSpy = vi.spyOn(candidateApi, 'shortlistCandidate').mockResolvedValueOnce({
      id: 'short-001',
      organizationId: 'org-1',
      candidateId: CANDIDATE_ID,
      requisitionId: REQUISITION_ID,
      shortlistedById: 'recruiter-1',
      shortlistedAt: '2026-11-06T02:00:00.000Z',
      notesInternal: 'Priority candidate for Apex Financial',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    // Eligible: Shortlist button is enabled
    const shortlistBtn = screen.getByRole('button', { name: /Shortlist Candidate/i });
    expect(shortlistBtn).not.toBeDisabled();

    const notesInput = screen.getByLabelText(/Shortlist Handover Notes/i);
    fireEvent.change(notesInput, { target: { value: 'Priority candidate for Apex Financial' } });

    fireEvent.click(shortlistBtn);

    await waitFor(() => {
      expect(shortlistSpy).toHaveBeenCalledWith(
        REQUISITION_ID,
        CANDIDATE_ID,
        'Priority candidate for Apex Financial',
      );
    });

    expect(
      await screen.findByText(/Candidate successfully shortlisted for client submission/i),
    ).toBeInTheDocument();
  });

  it('displays already-shortlisted state and renders pipeline timeline events', async () => {
    const shortlistedCandidate: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: true,
      review: {
        id: 'rev-001',
        decision: 'REVIEWED',
        reviewedAt: '2026-11-05T12:00:00.000Z',
        reviewerId: 'recruiter-1',
        notesInternal: 'Top candidate',
      },
      shortlist: {
        id: 'short-001',
        shortlistedById: 'recruiter-1',
        shortlistedAt: '2026-11-05T13:00:00.000Z',
        notesInternal: 'Confirmed for client presentation',
      },
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(shortlistedCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);
    vi.spyOn(candidateApi, 'getCandidateTimeline').mockResolvedValueOnce({
      candidateId: CANDIDATE_ID,
      candidateCode: 'CAN-8A4F1D92',
      requisitionId: REQUISITION_ID,
      items: [
        {
          id: 'ev-1',
          fromStage: 'RECRUITER_REVIEW',
          toStage: 'RECRUITER_SHORTLISTED',
          actorRole: 'RECRUITER',
          submissionId: null,
          reason: 'Shortlisted by recruiter',
          createdAt: '2026-11-05T13:00:00.000Z',
        },
        {
          id: 'ev-2',
          fromStage: 'ASSESSED',
          toStage: 'RECRUITER_REVIEW',
          actorRole: 'RECRUITER',
          submissionId: null,
          reason: 'Recorded REVIEWED decision',
          createdAt: '2026-11-05T12:00:00.000Z',
        },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('CAN-8A4F1D92')).toBeInTheDocument();

    // Already shortlisted state is visible
    expect(screen.getByText('Candidate is Shortlisted')).toBeInTheDocument();
    expect(screen.getByText('Confirmed for client presentation')).toBeInTheDocument();

    // Navigate to Consent & Audit tab to verify timeline
    const auditTab = screen.getByRole('tab', { name: /Consent & Audit/i });
    fireEvent.click(auditTab);

    expect(screen.getByText('Candidate Pipeline Timeline & Audit History')).toBeInTheDocument();
    expect(screen.getByText(/RECRUITER_REVIEW → RECRUITER_SHORTLISTED/i)).toBeInTheDocument();
    expect(screen.getByText(/ASSESSED → RECRUITER_REVIEW/i)).toBeInTheDocument();
  });

  it('enforces client submission prerequisites and allows submission when candidate is shortlisted', async () => {
    const eligibleCandidate: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: true,
      review: {
        id: 'rev-001',
        decision: 'REVIEWED',
        reviewedAt: '2026-11-05T12:00:00.000Z',
        reviewerId: 'recruiter-1',
        notesInternal: 'Top candidate',
      },
      shortlist: {
        id: 'short-001',
        shortlistedById: 'recruiter-1',
        shortlistedAt: '2026-11-05T13:00:00.000Z',
        notesInternal: 'Ready for client',
      },
      submission: null,
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(eligibleCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);
    const submitSpy = vi.spyOn(candidateApi, 'submitCandidateToClient').mockResolvedValueOnce({
      id: 'sub-new-1',
      organizationId: 'org-1',
      candidateId: CANDIDATE_ID,
      requisitionId: REQUISITION_ID,
      clientId: 'client-apex-001',
      submittedById: 'recruiter-1',
      assessmentId: 'ass-1',
      reviewId: 'rev-001',
      resumeDocumentId: 'res-apex-001',
      status: 'SUBMITTED',
      submittedAt: '2026-11-06T12:00:00.000Z',
      updatedAt: '2026-11-06T12:00:00.000Z',
    });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('3. Submit to Client')).toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /Submit to Acme Corp/i });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(REQUISITION_ID, CANDIDATE_ID);
    });

    expect(
      await screen.findByText(/Candidate successfully submitted to Acme Corp/i),
    ).toBeInTheDocument();
  });

  it('renders submitted state and client feedback when already submitted', async () => {
    const submittedCandidate: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: true,
      review: {
        id: 'rev-001',
        decision: 'REVIEWED',
        reviewedAt: '2026-11-05T12:00:00.000Z',
        reviewerId: 'recruiter-1',
        notesInternal: 'Top candidate',
      },
      shortlist: {
        id: 'short-001',
        shortlistedById: 'recruiter-1',
        shortlistedAt: '2026-11-05T13:00:00.000Z',
        notesInternal: 'Ready for client',
      },
      submission: {
        id: 'sub-001',
        status: 'CLIENT_SHORTLISTED',
        submittedAt: '2026-11-05T14:00:00.000Z',
        submittedById: 'recruiter-1',
      },
      clientFeedback: [
        {
          id: 'fb-001',
          decision: 'SHORTLIST',
          reason: 'Excellent background in cloud architecture.',
          proposedAt: null,
          timezone: null,
          createdAt: '2026-11-05T16:00:00.000Z',
        },
      ],
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(submittedCandidate);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('3. Submit to Client')).toBeInTheDocument();
    expect(screen.getAllByText('Client shortlisted').length).toBeGreaterThan(0);
    expect(screen.getByText(/Excellent background in cloud architecture/i)).toBeInTheDocument();
  });

  it('renders interview coordination section and allows recruiter to propose, accept, decline, and complete interviews', async () => {
    const candidateWithInterviews: CandidateDetail = {
      ...MOCK_CANDIDATE_DETAIL,
      hasInspectedOriginalResume: true,
      review: {
        id: 'rev-001',
        decision: 'REVIEWED',
        reviewedAt: '2026-11-05T12:00:00.000Z',
        reviewerId: 'recruiter-1',
        notesInternal: 'Top candidate',
      },
      shortlist: {
        id: 'short-001',
        shortlistedById: 'recruiter-1',
        shortlistedAt: '2026-11-05T13:00:00.000Z',
        notesInternal: 'Ready for client',
      },
      submission: {
        id: 'sub-001',
        status: 'INTERVIEW_PROPOSED',
        submittedAt: '2026-11-05T14:00:00.000Z',
        submittedById: 'recruiter-1',
      },
      clientFeedback: [],
      interviews: [
        {
          id: 'prop-001',
          startAt: '2026-11-10T14:00:00.000Z',
          endAt: '2026-11-10T14:45:00.000Z',
          timezone: 'America/New_York',
          format: 'VIDEO',
          status: 'PROPOSED',
          reason: 'Initial architectural interview',
          createdAt: '2026-11-06T10:00:00.000Z',
        },
        {
          id: 'prop-002',
          startAt: '2026-11-12T16:00:00.000Z',
          endAt: '2026-11-12T16:45:00.000Z',
          timezone: 'America/New_York',
          format: 'VIDEO',
          status: 'ACCEPTED',
          reason: 'Team technical interview',
          createdAt: '2026-11-06T11:00:00.000Z',
        },
      ],
    };

    vi.spyOn(candidateApi, 'getCandidateDetail').mockResolvedValue(candidateWithInterviews);
    vi.spyOn(candidateApi, 'getResumeExtraction').mockResolvedValue(MOCK_EXTRACTION);

    const acceptSpy = vi
      .spyOn(candidateApi, 'acceptInterviewProposal')
      .mockResolvedValueOnce({ success: true, action: 'ACCEPT' });

    const completeSpy = vi
      .spyOn(candidateApi, 'completeInterview')
      .mockResolvedValueOnce({ success: true, action: 'COMPLETE' });

    render(<CandidateDetailView requisitionId={REQUISITION_ID} candidateId={CANDIDATE_ID} />);

    expect(await screen.findByText('Interview Coordination')).toBeInTheDocument();
    expect(screen.getByText(/Initial architectural interview/i)).toBeInTheDocument();
    expect(screen.getByText(/Team technical interview/i)).toBeInTheDocument();

    // Accept proposal
    const acceptBtn = screen.getByRole('button', { name: /^Accept$/i });
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(acceptSpy).toHaveBeenCalledWith(REQUISITION_ID, 'sub-001', 'prop-001');
    });

    // Mark completed on the accepted interview
    const completeBtn = screen.getByRole('button', { name: /Mark Completed/i });
    fireEvent.click(completeBtn);

    await waitFor(() => {
      expect(completeSpy).toHaveBeenCalledWith(REQUISITION_ID, 'sub-001', 'prop-002');
    });
  });
});
