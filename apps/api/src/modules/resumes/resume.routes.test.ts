import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { deriveCsrfToken } from '../../middleware/csrf.js';
import type { SessionService } from '../auth/session.service.js';
import {
  ExtractionNotFoundError,
  RequisitionNotFoundError,
  ResumeNotFoundError,
  type ResumeService,
} from './resume.service.js';
import type { ResumeBatchUploadResult, ResumeDocumentDto } from './resume.types.js';

const rawToken = 'A'.repeat(43);
const requisitionId = '123e4567-e89b-42d3-a456-426614174000';
const resumeId = '223e4567-e89b-42d3-a456-426614174000';

const recruiterPrincipal = {
  userId: 'recruiter-a',
  organizationId: 'organization-a',
  role: 'RECRUITER' as const,
};

const hiringManagerPrincipal = {
  userId: 'hm-a',
  organizationId: 'organization-a',
  role: 'CLIENT_HIRING_MANAGER' as const,
};

const sampleResumeDto: ResumeDocumentDto = {
  id: resumeId,
  candidateId: 'cand-1',
  candidateCode: 'CAN-1234',
  fileName: 'resume.pdf',
  fileType: 'PDF',
  sizeBytes: 2048,
  sha256: 'abcd1234abcd1234',
  parseStatus: 'PARSED',
  uploadedAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
};

const sampleUploadResult: ResumeBatchUploadResult = {
  batchId: 'batch-1',
  totalFiles: 1,
  acceptedCount: 1,
  duplicateCount: 0,
  rejectedCount: 0,
  accepted: [
    {
      resumeDocumentId: resumeId,
      candidateId: 'cand-1',
      candidateCode: 'CAN-1234',
      fileName: 'resume.pdf',
      fileType: 'PDF',
      sizeBytes: 2048,
      sha256: 'abcd1234abcd1234',
      status: 'ACCEPTED',
    },
  ],
  duplicates: [],
  rejected: [],
};

function createTestApp(
  options: {
    principal?: typeof recruiterPrincipal | typeof hiringManagerPrincipal;
    uploadError?: Error;
    listError?: Error;
    getError?: Error;
    extractionError?: Error;
    fileError?: Error;
  } = {},
) {
  const principal = options.principal ?? recruiterPrincipal;
  const sessionService: Pick<SessionService, 'validateSession'> = {
    validateSession: vi.fn(async (token: string | null | undefined) =>
      token === rawToken ? principal : null,
    ),
  };

  const service: ResumeService = {
    uploadResumes: vi.fn(async () => {
      if (options.uploadError) throw options.uploadError;
      return sampleUploadResult;
    }),
    listResumes: vi.fn(async () => {
      if (options.listError) throw options.listError;
      return [sampleResumeDto];
    }),
    getResumeDetails: vi.fn(async () => {
      if (options.getError) throw options.getError;
      return sampleResumeDto;
    }),
    getExtraction: vi.fn(async () => {
      if (options.extractionError) throw options.extractionError;
      return {
        id: 'extraction-1',
        resumeDocumentId: resumeId,
        version: 1,
        extractedText: 'Extracted text',
        pageMap: { pages: [] },
        parser: 'talentlens-pdf-v1',
        ocrUsed: false,
        qualityStatus: 'COMPLETE' as const,
        createdAt: '2026-11-04T00:00:00.000Z',
      };
    }),
    getResumeFile: vi.fn(async () => {
      if (options.fileError) throw options.fileError;
      return {
        buffer: Buffer.from('%PDF-1.4 file'),
        mimeType: 'application/pdf',
        fileName: 'resume.pdf',
      };
    }),
  };

  return {
    service,
    app: createApp({
      resumes: {
        service,
        sessionService,
        applicationOrigin: 'http://localhost:5173',
        isProduction: false,
      },
    }),
  };
}

describe('Resume Ingestion Routes', () => {
  it('denies unauthenticated requests on resume endpoints', async () => {
    const { app } = createTestApp();
    const res = await request(app).get(`/api/v1/requisitions/${requisitionId}/resumes`);
    expect(res.status).toBe(401);
  });

  it('denies client hiring managers before service access', async () => {
    const { app, service } = createTestApp({ principal: hiringManagerPrincipal });
    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(403);
    expect(service.listResumes).not.toHaveBeenCalled();
  });

  it('rejects malformed requisition IDs before calling the service', async () => {
    const { app, service } = createTestApp();
    const res = await request(app)
      .get('/api/v1/requisitions/not-a-uuid/resumes')
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(400);
    expect(service.listResumes).not.toHaveBeenCalled();
  });

  it('rejects upload requests missing CSRF token', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`)
      .set('Origin', 'http://localhost:5173')
      .attach('files', Buffer.from('%PDF-1.4 test'), 'resume.pdf');

    expect(res.status).toBe(403);
  });

  it('rejects upload requests with mismatched Origin header', async () => {
    const { app } = createTestApp();
    const csrfToken = deriveCsrfToken(rawToken);

    const res = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`)
      .set('Origin', 'https://attacker.evil.com')
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('%PDF-1.4 test'), 'resume.pdf');

    expect(res.status).toBe(403);
  });

  it('accepts valid multipart uploads and returns 201 with batch result', async () => {
    const { app, service } = createTestApp();
    const csrfToken = deriveCsrfToken(rawToken);

    const res = await request(app)
      .post(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`)
      .set('Origin', 'http://localhost:5173')
      .set('x-csrf-token', csrfToken)
      .attach('files', Buffer.from('%PDF-1.4 test'), 'resume.pdf');

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBe('batch-1');
    expect(res.body.acceptedCount).toBe(1);
    expect(service.uploadResumes).toHaveBeenCalled();
  });

  it('lists resumes for an authorized requisition', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.resumes).toHaveLength(1);
    expect(res.body.resumes[0].id).toBe(resumeId);
  });

  it('returns 404 when requisition is not found', async () => {
    const { app } = createTestApp({
      listError: new RequisitionNotFoundError(),
    });

    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(404);
  });

  it('retrieves details for a specific resume', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.resume.id).toBe(resumeId);
    expect(res.body.resume.candidateCode).toBe('CAN-1234');
  });

  it('returns 404 when resume details are not found', async () => {
    const { app } = createTestApp({
      getError: new ResumeNotFoundError(),
    });

    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(404);
  });

  it('retrieves text extraction results for a resume', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/extraction`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.extraction.extractedText).toBe('Extracted text');
    expect(res.body.extraction.parser).toBe('talentlens-pdf-v1');
  });

  it('returns 404 when extraction results are not found', async () => {
    const { app } = createTestApp({
      extractionError: new ExtractionNotFoundError(),
    });

    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/extraction`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(404);
  });

  it('streams original resume file with correct headers', async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .get(`/api/v1/requisitions/${requisitionId}/resumes/${resumeId}/file`)
      .set('Cookie', `talentlens_session=${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toContain('inline; filename="resume.pdf"');
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''resume.pdf");
    expect(res.body.toString('latin1')).toContain('%PDF-1.4 file');
  });
});
