import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, apiClient } from '../../lib/api-client.js';
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
  finalizeResumeBatch,
  getCandidateDetail,
  getCandidateTimeline,
  getResumeBatchStatus,
  getResumeDetails,
  getResumeExtraction,
  getResumeFileBlob,
  listCandidates,
  listGlobalCandidates,
  listSubmissionsForRequisition,
  reconcileAndFinalizeResumeBatch,
  recordCandidateReview,
  resolveCandidateErrorMessage,
  resolveUploadErrorMessage,
  shortlistCandidate,
  submitCandidateToClient,
  triggerCandidateAssessment,
  uploadResumes,
  validateUploadFile,
} from './candidate.api.js';
import type {
  CandidateDetail,
  CandidateSummary,
  DocumentExtraction,
  GlobalCandidateSummary,
  ResumeBatchUploadResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_CANDIDATE: CandidateSummary = {
  candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  candidateCode: 'CAN-A1B2C3D4',
  resumeDocumentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resumeFileName: 'john-doe-cv.pdf',
  parseStatus: 'PARSED',
  assessmentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  assessmentStatus: 'COMPLETE',
  overallScore: 78,
  coverage: 0.85,
  isComplete: true,
  criteriaCount: 5,
  criteriaMetCount: 4,
  reviewStatus: 'NOT_REVIEWED',
  reviewedAt: null,
  isShortlisted: false,
  shortlistedAt: null,
  submissionId: null,
  submissionStatus: null,
  submittedAt: null,
  lastActivityAt: '2026-10-20T10:00:00.000Z',
};

const SAMPLE_PENDING_CANDIDATE: CandidateSummary = {
  candidateId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  candidateCode: 'CAN-E5F6G7H8',
  resumeDocumentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  resumeFileName: 'jane-smith-cv.docx',
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
  lastActivityAt: '2026-10-21T09:00:00.000Z',
};

const REQUISITION_ID = '11111111-1111-4111-8111-111111111111';

function makePdfFile(name = 'resume.pdf', size = 1024): File {
  return new File([new Uint8Array(size).fill(37)], name, { type: 'application/pdf' });
}

function makeDocxFile(name = 'resume.docx', size = 1024): File {
  return new File([new Uint8Array(size).fill(0)], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function makeOversizedFile(): File {
  // Size just above 10MB limit
  return new File([new Uint8Array(UPLOAD_MAX_FILE_BYTES + 1).fill(37)], 'huge.pdf', {
    type: 'application/pdf',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('candidate.api — listCandidates', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. sends GET /requisitions/:id/candidates and parses valid DTO', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      items: [SAMPLE_CANDIDATE],
      total: 1,
    });

    const result = await listCandidates(REQUISITION_ID);

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(`/requisitions/${REQUISITION_ID}/candidates`, {});
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.candidateId).toBe(SAMPLE_CANDIDATE.candidateId);
    expect(result.total).toBe(1);
  });

  it('2. appends query params for filtering when provided', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ items: [], total: 0 });

    await listCandidates(REQUISITION_ID, {
      limit: 20,
      offset: 10,
      processingStatus: 'PARSED',
      reviewDecision: 'REVIEWED',
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    const calledPath: string = getSpy.mock.calls[0]?.[0] as string;
    expect(calledPath).toContain('limit=20');
    expect(calledPath).toContain('offset=10');
    expect(calledPath).toContain('processingStatus=PARSED');
    expect(calledPath).toContain('reviewDecision=REVIEWED');
  });

  it('3. rejects empty requisitionId before making a network call', async () => {
    const getSpy = vi.spyOn(apiClient, 'get');

    await expect(listCandidates('   ')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      code: 'invalid_request',
    });

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('4. rejects malformed server response with 502 invalid_response_format', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      // Missing 'total' and items contain invalid record
      items: [{ candidateId: '' }],
    });

    await expect(listCandidates(REQUISITION_ID)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('5. rejects when items field is missing from response', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ total: 0 });

    await expect(listCandidates(REQUISITION_ID)).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('6. parses PENDING candidate (no assessment) correctly', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      items: [SAMPLE_PENDING_CANDIDATE],
      total: 1,
    });

    const result = await listCandidates(REQUISITION_ID);

    expect(result.items[0]?.assessmentId).toBeNull();
    expect(result.items[0]?.assessmentStatus).toBeNull();
    expect(result.items[0]?.parseStatus).toBe('PENDING');
    expect(result.items[0]?.reviewStatus).toBe('NOT_REVIEWED');
  });

  it('7. forwards signal to apiClient.get for cancellation', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ items: [], total: 0 });
    const controller = new AbortController();

    await listCandidates(REQUISITION_ID, {}, controller.signal);

    expect(getSpy).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
  });

  it('8. distinguishes 401 session expired from 403 forbidden', async () => {
    const unauth = new ApiError({
      status: 401,
      code: 'unauthenticated',
      message: 'Session expired',
    });
    expect(resolveCandidateErrorMessage(unauth, 'default')).toContain('session has expired');

    const forbidden = new ApiError({ status: 403, code: 'forbidden', message: 'Forbidden' });
    expect(resolveCandidateErrorMessage(forbidden, 'default')).toContain('permission');
  });
});

describe('candidate.api — validateUploadFile', () => {
  it('9. rejects files with unsupported extension', () => {
    const txt = new File(['hello'], 'resume.txt', { type: 'text/plain' });
    expect(validateUploadFile(txt)).toMatch(/not a supported format/i);
  });

  it('10. rejects files exceeding the 10 MB size limit', () => {
    const oversized = makeOversizedFile();
    expect(validateUploadFile(oversized)).toMatch(/exceeds the/i);
  });

  it('11. rejects empty files', () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    expect(validateUploadFile(empty)).toMatch(/empty/i);
  });

  it('12. accepts valid PDF file within size limit', () => {
    const valid = makePdfFile('valid-resume.pdf', 500 * 1024);
    expect(validateUploadFile(valid)).toBeNull();
  });

  it('13. accepts valid DOCX file within size limit', () => {
    const valid = makeDocxFile('valid-resume.docx', 1 * 1024 * 1024);
    expect(validateUploadFile(valid)).toBeNull();
  });

  it('14. accepts file at exactly the size limit boundary', () => {
    const atLimit = new File([new Uint8Array(UPLOAD_MAX_FILE_BYTES).fill(37)], 'boundary.pdf', {
      type: 'application/pdf',
    });
    expect(validateUploadFile(atLimit)).toBeNull();
  });
});

describe('candidate.api — uploadResumes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SAMPLE_UPLOAD_RESULT: ResumeBatchUploadResult = {
    batchId: 'batch-aaaa-bbbb-cccc',
    totalFiles: 2,
    acceptedCount: 2,
    duplicateCount: 0,
    rejectedCount: 0,
    accepted: [
      {
        resumeDocumentId: 'rrrr-rrrr-rrrr-rrrr',
        candidateId: 'ccc1-ccc1-ccc1-ccc1',
        candidateCode: 'CAN-11111111',
        fileName: 'resume1.pdf',
        fileType: 'PDF',
        sizeBytes: 1024,
        sha256: 'abc123',
        status: 'ACCEPTED',
      },
    ],
    duplicates: [],
    rejected: [],
  };

  it('15. sends POST with FormData to correct path and parses response', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(SAMPLE_UPLOAD_RESULT);

    const files = [makePdfFile()];
    const result = await uploadResumes(REQUISITION_ID, files);

    expect(postSpy).toHaveBeenCalledTimes(1);
    const calledPath: string = postSpy.mock.calls[0]?.[0] as string;
    const calledBody = postSpy.mock.calls[0]?.[1];
    expect(calledPath).toBe(`/requisitions/${REQUISITION_ID}/resumes`);
    expect(calledBody).toBeInstanceOf(FormData);
    expect(result.batchId).toBe('batch-aaaa-bbbb-cccc');
    expect(result.acceptedCount).toBe(2);
  });

  it('16. appends each file to FormData under field name "files"', async () => {
    const capturedFormData: FormData[] = [];
    vi.spyOn(apiClient, 'post').mockImplementation(async (_path, body) => {
      capturedFormData.push(body as FormData);
      return SAMPLE_UPLOAD_RESULT;
    });

    const files = [makePdfFile('a.pdf'), makeDocxFile('b.docx')];
    await uploadResumes(REQUISITION_ID, files);

    expect(capturedFormData).toHaveLength(1);
    const fd = capturedFormData[0]!;
    const entries = Array.from(fd.getAll('files'));
    expect(entries).toHaveLength(2);
  });

  it('17. rejects empty requisitionId before network call', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');

    await expect(uploadResumes('  ', [makePdfFile()])).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('18. rejects empty file list before network call', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');

    await expect(uploadResumes(REQUISITION_ID, [])).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: expect.stringContaining('At least one file'),
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('19. rejects batch exceeding UPLOAD_MAX_FILES before network call', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');
    const tooMany = Array.from({ length: UPLOAD_MAX_FILES + 1 }, (_, i) =>
      makePdfFile(`resume-${i}.pdf`),
    );

    await expect(uploadResumes(REQUISITION_ID, tooMany)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
      message: expect.stringContaining(`${UPLOAD_MAX_FILES} files`),
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('19b. chunks bulk uploads exceeding UPLOAD_CHUNK_SIZE into bounded requests with batchId continuity', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockImplementation(async (_path) => {
      return {
        batchId: 'batch-shared-500',
        totalFiles: 3,
        acceptedCount: 3,
        duplicateCount: 0,
        rejectedCount: 0,
        accepted: [
          {
            resumeDocumentId: 'doc-1',
            candidateId: 'cand-1',
            candidateCode: 'CAN-1',
            fileName: 'chunk.pdf',
            fileType: 'PDF',
            sizeBytes: 100,
            sha256: 'sha1',
            status: 'ACCEPTED',
          },
        ],
        duplicates: [],
        rejected: [],
      };
    });

    const progressReports: number[] = [];
    // 6 files with UPLOAD_CHUNK_SIZE = 3 -> 2 chunks (3 + 3)
    const sixFiles = Array.from({ length: 6 }, (_, i) => makePdfFile(`res-${i}.pdf`));
    const result = await uploadResumes(REQUISITION_ID, sixFiles, undefined, (p) => {
      progressReports.push(p.percent);
    });

    expect(postSpy).toHaveBeenCalledTimes(2);
    // First chunk creates batch
    expect(postSpy.mock.calls[0]?.[0]).toBe(`/requisitions/${REQUISITION_ID}/resumes`);
    // Second chunk passes batchId continuity
    expect(postSpy.mock.calls[1]?.[0]).toContain('batchId=batch-shared-500');
    expect(result.totalFiles).toBe(6);
    expect(progressReports.length).toBe(2);
    expect(progressReports[1]).toBe(100);
  });

  it('19b2. appends ?isFinal=true on single direct upload when options.isFinal is true', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(SAMPLE_UPLOAD_RESULT);

    await uploadResumes(REQUISITION_ID, [makePdfFile()], { isFinal: true });

    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0]?.[0]).toBe(`/requisitions/${REQUISITION_ID}/resumes?isFinal=true`);
  });

  it('19b3. finalizeResumeBatch validates IDs and calls batch finalize endpoint', async () => {
    await expect(finalizeResumeBatch('  ', 'batch-1')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    const postSpy = vi
      .spyOn(apiClient, 'post')
      .mockResolvedValueOnce({ id: 'batch-1', status: 'COMPLETED', isOpen: false });

    const res = await finalizeResumeBatch(REQUISITION_ID, 'batch-1');
    expect(postSpy).toHaveBeenCalledWith(
      `/requisitions/${REQUISITION_ID}/resumes/batches/batch-1/finalize`,
      {},
      {},
    );
    expect(res).toEqual({ id: 'batch-1', status: 'COMPLETED', isOpen: false });
  });

  it('19b4. finalizeResumeBatch rejects malformed batch IDs and invalid server responses', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');
    await expect(finalizeResumeBatch(REQUISITION_ID, '   ')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    await expect(finalizeResumeBatch(REQUISITION_ID, 'batch/invalid')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(postSpy).not.toHaveBeenCalled();

    postSpy.mockResolvedValueOnce({ id: 'batch-1', status: 'PROCESSING', isOpen: true });
    await expect(finalizeResumeBatch(REQUISITION_ID, 'batch-1')).rejects.toMatchObject({
      status: 409,
      code: 'batch_not_finalized',
    });

    postSpy.mockResolvedValueOnce({ status: 'COMPLETED' });
    await expect(finalizeResumeBatch(REQUISITION_ID, 'batch-1')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('19b5. finalizeResumeBatch reconciles lost network response via GET /batches/:batchId when server already finalized', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 0,
        code: 'network_error',
        message: 'Connection reset before response received',
      }),
    );
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ id: 'batch-1', status: 'PROCESSING', isOpen: false });

    const res = await finalizeResumeBatch(REQUISITION_ID, 'batch-1');
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(getSpy).toHaveBeenCalledWith(
      `/requisitions/${REQUISITION_ID}/resumes/batches/batch-1`,
      {},
    );
    expect(res).toEqual({ id: 'batch-1', status: 'PROCESSING', isOpen: false });
  });

  it('19b6. finalizeResumeBatch propagates network failure when server batch remains open or unreachable', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValueOnce(
      new ApiError({
        status: 0,
        code: 'network_error',
        message: 'Network down',
      }),
    );
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      id: 'batch-1',
      status: 'PROCESSING',
      isOpen: true,
    });

    await expect(finalizeResumeBatch(REQUISITION_ID, 'batch-1')).rejects.toMatchObject({
      status: 0,
      code: 'network_error',
    });
  });

  it('19b7. reconcileAndFinalizeResumeBatch checks server state first and skips duplicate finalize POST when already closed', async () => {
    const getSpy = vi
      .spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ id: 'batch-1', status: 'COMPLETED', isOpen: false });
    const postSpy = vi.spyOn(apiClient, 'post');

    const alreadyClosed = await reconcileAndFinalizeResumeBatch(REQUISITION_ID, 'batch-1');
    expect(alreadyClosed).toEqual({ id: 'batch-1', status: 'COMPLETED', isOpen: false });
    expect(postSpy).not.toHaveBeenCalled();

    getSpy.mockResolvedValueOnce({ id: 'batch-1', status: 'QUEUED', isOpen: true });
    postSpy.mockResolvedValueOnce({ id: 'batch-1', status: 'PROCESSING', isOpen: false });
    const closedNow = await reconcileAndFinalizeResumeBatch(REQUISITION_ID, 'batch-1');
    expect(closedNow).toEqual({ id: 'batch-1', status: 'PROCESSING', isOpen: false });
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('19b8. getResumeBatchStatus rejects malformed batch IDs and mismatched server payloads', async () => {
    await expect(getResumeBatchStatus(REQUISITION_ID, '')).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });

    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      id: 'different-batch',
      status: 'COMPLETED',
      isOpen: false,
    });
    await expect(getResumeBatchStatus(REQUISITION_ID, 'batch-1')).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('19c. rejects bulk uploads exceeding 1 GB cumulative batch limit', async () => {
    const postSpy = vi.spyOn(apiClient, 'post');
    // Create 2 files whose total size exceeds 1 GB
    const hugeFile1 = { name: 'huge1.pdf', size: 600 * 1024 * 1024 } as File;
    const hugeFile2 = { name: 'huge2.pdf', size: 600 * 1024 * 1024 } as File;

    await expect(uploadResumes(REQUISITION_ID, [hugeFile1, hugeFile2])).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('20. rejects malformed server response with 502 invalid_response_format', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValueOnce({ invalidKey: true });

    await expect(uploadResumes(REQUISITION_ID, [makePdfFile()])).rejects.toMatchObject({
      status: 502,
      code: 'invalid_response_format',
    });
  });

  it('21. resolveUploadErrorMessage maps 413 to file-size human message', () => {
    const tooLarge = new ApiError({
      status: 413,
      code: 'file_too_large',
      message: 'File too large',
    });
    expect(resolveUploadErrorMessage(tooLarge)).toContain('maximum size');
  });

  it('22. resolveUploadErrorMessage maps 403 to permission message', () => {
    const forbidden = new ApiError({ status: 403, code: 'forbidden', message: 'Forbidden' });
    expect(resolveUploadErrorMessage(forbidden)).toContain('permission');
  });

  it('23. resolveUploadErrorMessage maps network error to connection message', () => {
    const networkError = new ApiError({
      status: 0,
      code: 'network_error',
      message: 'Failed to fetch',
    });
    expect(resolveUploadErrorMessage(networkError)).toContain('connection');
  });

  it('24. resolveUploadErrorMessage handles non-ApiError gracefully', () => {
    expect(resolveUploadErrorMessage(new Error('generic'))).toContain('unexpected error');
    expect(resolveUploadErrorMessage('string error')).toContain('unexpected error');
  });
});

describe('Candidate detail & Resume inspection API', () => {
  const REQUISITION_ID = '11111111-1111-4111-8111-111111111111';
  const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
  const RESUME_ID = '33333333-3333-4333-8333-333333333333';

  const SAMPLE_DETAIL: CandidateDetail = {
    candidateId: CANDIDATE_ID,
    candidateCode: 'CAN-8A4F1D92',
    requisitionId: REQUISITION_ID,
    requisitionTitle: 'Staff Backend Engineer',
    client: {
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Acme Corporation',
    },
    resume: {
      id: RESUME_ID,
      fileName: 'alex-mercer-cv.pdf',
      fileType: 'PDF',
      sizeBytes: 1048576,
      uploadedAt: '2026-10-25T14:30:00.000Z',
    },
    hasInspectedOriginalResume: false,
    consent: {
      id: '55555555-5555-4555-8555-555555555555',
      status: 'ACTIVE',
      policyVersion: '1.0',
      capturedAt: '2026-10-25T14:28:00.000Z',
    },
    assessment: {
      id: '66666666-6666-4666-8666-666666666666',
      status: 'COMPLETE',
      score: 88,
      coverage: 0.95,
      isComplete: true,
      formulaVersion: '1.0.0',
      criteria: [
        {
          id: 'crit-1',
          key: 'distributed_systems',
          label: 'Distributed Systems',
          category: 'TECHNICAL',
          requirementType: 'MUST_HAVE',
          weight: 25,
          status: 'MET',
          confidence: 'HIGH',
          score: 90,
          reasoning: 'Extensive microservices and Raft consensus experience.',
          evidence: [
            {
              quote: 'Designed and implemented multi-region Raft cluster in Go.',
              pageNumber: 2,
              startOffset: 120,
              endOffset: 180,
              verified: true,
            },
          ],
        },
      ],
    },
    review: null,
    shortlist: null,
    submission: null,
    clientFeedback: [],
  };

  const SAMPLE_EXTRACTION: DocumentExtraction = {
    id: '77777777-7777-4777-8777-777777777777',
    resumeDocumentId: RESUME_ID,
    version: 1,
    extractedText: 'Alex Mercer\nSenior Backend Engineer\nDistributed Systems Specialist',
    pageMap: { '1': { text: 'Alex Mercer...' } },
    parser: 'PDF_PARSER_V2',
    ocrUsed: false,
    qualityStatus: 'COMPLETE',
    createdAt: '2026-10-25T14:31:00.000Z',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCandidateDetail', () => {
    it('fetches and validates candidate detail successfully', async () => {
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(SAMPLE_DETAIL);

      const result = await getCandidateDetail(REQUISITION_ID, CANDIDATE_ID);

      expect(getSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}`,
        {},
      );
      expect(result.candidateCode).toBe('CAN-8A4F1D92');
      expect(result.hasInspectedOriginalResume).toBe(false);
      expect(result.client.name).toBe('Acme Corporation');
    });

    it('rejects empty or whitespace requisitionId', async () => {
      await expect(getCandidateDetail('   ', CANDIDATE_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });

    it('rejects empty or whitespace candidateId', async () => {
      await expect(getCandidateDetail(REQUISITION_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });

    it('rejects malformed response shape with 502', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
        candidateId: CANDIDATE_ID,
        // missing candidateCode, client, resume, etc.
      });

      await expect(getCandidateDetail(REQUISITION_ID, CANDIDATE_ID)).rejects.toMatchObject({
        status: 502,
        code: 'invalid_response_format',
      });
    });
  });

  describe('getResumeExtraction', () => {
    it('fetches extraction payload successfully', async () => {
      const getSpy = vi
        .spyOn(apiClient, 'get')
        .mockResolvedValueOnce({ extraction: SAMPLE_EXTRACTION });

      const result = await getResumeExtraction(REQUISITION_ID, RESUME_ID);

      expect(getSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/resumes/${RESUME_ID}/extraction`,
        {},
      );
      expect(result.extractedText).toContain('Alex Mercer');
      expect(result.qualityStatus).toBe('COMPLETE');
      expect(result.ocrUsed).toBe(false);
    });

    it('rejects invalid extraction IDs', async () => {
      await expect(getResumeExtraction('', RESUME_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });

    it('rejects malformed extraction response with 502', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
        extraction: { id: 'ext-1' }, // missing extractedText, parser, etc.
      });

      await expect(getResumeExtraction(REQUISITION_ID, RESUME_ID)).rejects.toMatchObject({
        status: 502,
        code: 'invalid_response_format',
      });
    });
  });

  describe('getResumeFileBlob', () => {
    it('downloads blob, parses filename from header, and respects same-origin credentials', async () => {
      const mockBlob = new Blob(['%PDF-1.4 mock content'], { type: 'application/pdf' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="john-doe-cv.pdf"',
        }),
        blob: async () => mockBlob,
      } as unknown as Response);

      const result = await getResumeFileBlob(REQUISITION_ID, RESUME_ID);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/requisitions/${REQUISITION_ID}/resumes/${RESUME_ID}/file`),
        expect.objectContaining({
          method: 'GET',
          credentials: 'same-origin',
        }),
      );
      expect(result.blob).toBe(mockBlob);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.fileName).toBe('john-doe-cv.pdf');
    });

    it('handles 404 not found properly', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 404,
      } as unknown as Response);

      await expect(getResumeFileBlob(REQUISITION_ID, RESUME_ID)).rejects.toMatchObject({
        status: 404,
        code: 'not_found',
      });
    });

    it('handles network failure properly', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(getResumeFileBlob(REQUISITION_ID, RESUME_ID)).rejects.toMatchObject({
        status: 0,
        code: 'network_error',
      });
    });
  });

  describe('getResumeDetails', () => {
    it('retrieves resume details including server-backed parseStatus', async () => {
      const mockResumeDto = {
        id: RESUME_ID,
        candidateId: CANDIDATE_ID,
        candidateCode: 'CAN-8A4F1D92',
        fileName: 'resume.pdf',
        fileType: 'PDF' as const,
        sizeBytes: 153600,
        sha256: 'a'.repeat(64),
        parseStatus: 'PARSED' as const,
        uploadedAt: '2026-11-05T00:00:00.000Z',
        updatedAt: '2026-11-05T00:01:00.000Z',
      };

      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
        resume: mockResumeDto,
      });

      const result = await getResumeDetails(REQUISITION_ID, RESUME_ID);

      expect(getSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/resumes/${RESUME_ID}`,
        {},
      );
      expect(result).toEqual(mockResumeDto);
      expect(result.parseStatus).toBe('PARSED');
    });

    it('rejects invalid inputs with 400', async () => {
      await expect(getResumeDetails('', RESUME_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(getResumeDetails(REQUISITION_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });

    it('rejects malformed response format with 502', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
        resume: { id: RESUME_ID }, // missing required fields
      });

      await expect(getResumeDetails(REQUISITION_ID, RESUME_ID)).rejects.toMatchObject({
        status: 502,
        code: 'invalid_response_format',
      });
    });
  });

  describe('triggerCandidateAssessment', () => {
    it('enqueues or idempotently retrieves assessment job via POST', async () => {
      const mockEnqueueResult = {
        job: {
          jobId: 'job-123',
          batchId: 'batch-123',
          requisitionId: REQUISITION_ID,
          candidateId: CANDIDATE_ID,
          resumeDocumentId: RESUME_ID,
          jobType: 'ASSESS_CANDIDATE',
          status: 'QUEUED',
          attempts: 0,
          lastErrorCode: null,
          createdAt: '2026-11-05T00:00:00.000Z',
          updatedAt: '2026-11-05T00:00:00.000Z',
        },
        assessment: null,
        isExisting: false,
      };

      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
        status: 'success',
        data: mockEnqueueResult,
      });

      const result = await triggerCandidateAssessment(REQUISITION_ID, RESUME_ID);

      expect(postSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/resumes/${RESUME_ID}/assessments`,
        {},
        {},
      );
      expect(result).toEqual(mockEnqueueResult);
      expect(result.isExisting).toBe(false);
      expect(result.job?.status).toBe('QUEUED');
    });

    it('rejects invalid requisition or resume IDs', async () => {
      await expect(triggerCandidateAssessment('', RESUME_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(triggerCandidateAssessment(REQUISITION_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });

    it('rejects malformed response with 502', async () => {
      vi.spyOn(apiClient, 'post').mockResolvedValueOnce({
        status: 'success',
        data: { invalid: true }, // missing isExisting
      });

      await expect(triggerCandidateAssessment(REQUISITION_ID, RESUME_ID)).rejects.toMatchObject({
        status: 502,
        code: 'invalid_response_format',
      });
    });
  });

  describe('candidate.api — recordCandidateReview', () => {
    it('successfully posts review decision with trimmed internal notes', async () => {
      const mockResult = {
        id: 'rev-123',
        decision: 'REVIEWED' as const,
        reviewedAt: '2026-11-06T00:00:00.000Z',
      };
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResult);

      const res = await recordCandidateReview(
        REQUISITION_ID,
        CANDIDATE_ID,
        'REVIEWED',
        '  Strong Raft consensus background.  ',
      );

      expect(postSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}/reviews`,
        {
          decision: 'REVIEWED',
          notesInternal: 'Strong Raft consensus background.',
        },
      );
      expect(res).toEqual(mockResult);
    });

    it('rejects invalid requisition or candidate IDs with 400', async () => {
      await expect(recordCandidateReview('', CANDIDATE_ID, 'REVIEWED')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(recordCandidateReview(REQUISITION_ID, '', 'REVIEWED')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('candidate.api — shortlistCandidate', () => {
    it('successfully posts shortlist request with optional notes', async () => {
      const mockResult = {
        id: 'short-123',
        organizationId: 'org-1',
        candidateId: CANDIDATE_ID,
        requisitionId: REQUISITION_ID,
        shortlistedById: 'user-recruiter-1',
        shortlistedAt: '2026-11-06T00:00:00.000Z',
        notesInternal: 'Top candidate for client submission',
      };
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockResult);

      const res = await shortlistCandidate(
        REQUISITION_ID,
        CANDIDATE_ID,
        'Top candidate for client submission',
      );

      expect(postSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}/shortlist`,
        {
          notesInternal: 'Top candidate for client submission',
        },
      );
      expect(res).toEqual(mockResult);
    });

    it('rejects invalid requisition or candidate IDs with 400', async () => {
      await expect(shortlistCandidate('', CANDIDATE_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(shortlistCandidate(REQUISITION_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('candidate.api — getCandidateTimeline', () => {
    it('successfully fetches candidate timeline and sets query params', async () => {
      const mockTimeline = {
        candidateId: CANDIDATE_ID,
        candidateCode: 'CAN-8899',
        requisitionId: REQUISITION_ID,
        items: [
          {
            id: 'ev-1',
            fromStage: 'ASSESSED',
            toStage: 'RECRUITER_REVIEW',
            actorRole: 'RECRUITER',
            submissionId: null,
            reason: 'Reviewed by recruiter',
            createdAt: '2026-11-06T00:00:00.000Z',
          },
        ],
        total: 1,
        limit: 20,
        offset: 0,
      };
      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockTimeline);

      const res = await getCandidateTimeline(REQUISITION_ID, CANDIDATE_ID, {
        limit: 20,
        offset: 0,
      });

      expect(getSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}/timeline?limit=20&offset=0`,
      );
      expect(res).toEqual(mockTimeline);
    });

    it('rejects invalid requisition or candidate IDs with 400', async () => {
      await expect(getCandidateTimeline('', CANDIDATE_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(getCandidateTimeline(REQUISITION_ID, '')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('candidate.api — submitCandidateToClient', () => {
    it('successfully posts submission request to backend endpoint', async () => {
      const mockSubmission = {
        id: 'sub-1',
        organizationId: 'org-1',
        candidateId: CANDIDATE_ID,
        requisitionId: REQUISITION_ID,
        clientId: 'client-1',
        submittedById: 'user-recruiter-1',
        assessmentId: 'ass-1',
        reviewId: 'rev-1',
        resumeDocumentId: 'doc-1',
        status: 'SUBMITTED',
        submittedAt: '2026-11-06T00:00:00.000Z',
        updatedAt: '2026-11-06T00:00:00.000Z',
      };
      const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValueOnce(mockSubmission);

      const res = await submitCandidateToClient(REQUISITION_ID, CANDIDATE_ID);

      expect(postSpy).toHaveBeenCalledWith(
        `/requisitions/${REQUISITION_ID}/candidates/${CANDIDATE_ID}/submissions`,
        {},
      );
      expect(res).toEqual(mockSubmission);
    });

    it('rejects invalid requisition or candidate IDs with 400', async () => {
      await expect(submitCandidateToClient('', CANDIDATE_ID)).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
      await expect(submitCandidateToClient(REQUISITION_ID, '   ')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('candidate.api — listSubmissionsForRequisition', () => {
    it('successfully retrieves submissions for requisition', async () => {
      const mockSubmissions = [
        {
          id: 'sub-1',
          organizationId: 'org-1',
          candidateId: CANDIDATE_ID,
          requisitionId: REQUISITION_ID,
          clientId: 'client-1',
          submittedById: 'user-recruiter-1',
          assessmentId: 'ass-1',
          reviewId: 'rev-1',
          resumeDocumentId: 'doc-1',
          status: 'SUBMITTED',
          submittedAt: '2026-11-06T00:00:00.000Z',
          updatedAt: '2026-11-06T00:00:00.000Z',
        },
      ];
      const getSpy = vi
        .spyOn(apiClient, 'get')
        .mockResolvedValueOnce({ submissions: mockSubmissions });

      const res = await listSubmissionsForRequisition(REQUISITION_ID);

      expect(getSpy).toHaveBeenCalledWith(`/requisitions/${REQUISITION_ID}/submissions`);
      expect(res).toEqual(mockSubmissions);
    });

    it('rejects empty requisition ID with 400', async () => {
      await expect(listSubmissionsForRequisition('')).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    });
  });

  describe('candidate.api — listGlobalCandidates', () => {
    const SAMPLE_GLOBAL_CANDIDATE: GlobalCandidateSummary = {
      candidateId: 'cand-global-1',
      candidateCode: 'CAN-GLOBAL-1',
      createdAt: '2026-11-05T09:00:00.000Z',
      lastActivityAt: '2026-11-05T12:00:00.000Z',
      requisitionId: REQUISITION_ID,
      requisitionTitle: 'Staff Engineer',
      clientName: 'Acme Corp',
      resumeDocumentId: 'doc-1',
      resumeFileName: 'resume.pdf',
      parseStatus: 'PARSED',
      currentRole: 'Backend Lead',
      experienceYears: 8,
      location: 'Bangalore',
      skills: ['TypeScript', 'Node.js'],
      assessmentId: 'ass-1',
      assessmentStatus: 'COMPLETE',
      overallScore: 89,
      coverage: 0.95,
      isComplete: true,
      criteriaCount: 4,
      criteriaMetCount: 4,
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-11-05T11:00:00.000Z',
      isShortlisted: true,
      shortlistedAt: '2026-11-05T11:30:00.000Z',
      submissionStatus: 'SUBMITTED',
      submittedAt: '2026-11-05T12:00:00.000Z',
      statusCategory: 'ASSESSED',
    };

    it('successfully queries global candidates with query params', async () => {
      const mockResponse = {
        items: [SAMPLE_GLOBAL_CANDIDATE],
        total: 1,
        page: 2,
        pageSize: 10,
        totalPages: 1,
      };

      const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValueOnce(mockResponse);

      const res = await listGlobalCandidates({
        page: 2,
        pageSize: 10,
        search: 'Backend',
        requisitionId: REQUISITION_ID,
        statusCategory: 'ASSESSED',
        sortBy: 'score',
        sortOrder: 'desc',
      });

      expect(getSpy).toHaveBeenCalledWith(expect.stringContaining('/candidates?'), {});
      const url = getSpy.mock.calls[0]![0] as string;
      expect(url).toContain('page=2');
      expect(url).toContain('pageSize=10');
      expect(url).toContain('search=Backend');
      expect(url).toContain(`requisitionId=${REQUISITION_ID}`);
      expect(url).toContain('statusCategory=ASSESSED');
      expect(url).toContain('sortBy=score');
      expect(url).toContain('sortOrder=desc');
      expect(res).toEqual(mockResponse);
    });

    it('rejects invalid response shape with 502 ApiError', async () => {
      vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
        items: [{ invalid: true }],
        total: 'not-a-number',
      });

      await expect(listGlobalCandidates()).rejects.toMatchObject({
        status: 502,
        code: 'invalid_response_format',
      });
    });
  });
});
