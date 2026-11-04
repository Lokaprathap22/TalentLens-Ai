import type { Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';

import { requireCsrf } from '../../middleware/csrf.js';
import { createRequireRole } from '../../middleware/require-role.js';
import { createRequireSession } from '../../middleware/require-session.js';
import { createRequireSameOrigin } from '../../middleware/origin-protection.js';
import type { AuthenticatedPrincipal, SessionService } from '../auth/session.service.js';
import {
  ExtractionNotFoundError,
  RequisitionNotFoundError,
  ResumeNotFoundError,
  ResumeRoleError,
  type ResumeService,
} from './resume.service.js';
import { FileTooLargeError, MultipartUploadError, TooManyFilesError } from './resume.multipart.js';
import { listResumesQuerySchema } from './resume.schemas.js';

const uuidSchema = z.string().uuid();

export interface ResumeRouterDependencies {
  service: ResumeService;
  sessionService: Pick<SessionService, 'validateSession'>;
  applicationOrigin: string;
  isProduction: boolean;
}

function parseUuid(value: string | string[] | undefined): string | null {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function handleError(error: unknown, response: Response): void {
  if (
    error instanceof RequisitionNotFoundError ||
    error instanceof ResumeNotFoundError ||
    error instanceof ExtractionNotFoundError
  ) {
    response.status(404).json({ error: 'not_found' });
  } else if (error instanceof ResumeRoleError) {
    response.status(403).json({ error: 'forbidden' });
  } else if (error instanceof FileTooLargeError) {
    response.status(413).json({ error: 'file_too_large', message: error.message });
  } else if (error instanceof TooManyFilesError || error instanceof MultipartUploadError) {
    response.status(400).json({ error: 'invalid_request', message: error.message });
  } else {
    response.status(503).json({ error: 'service_unavailable' });
  }
}

export function createResumeRouter(dependencies: ResumeRouterDependencies): Router {
  const router = express.Router();

  const requireSession = createRequireSession({
    sessionService: dependencies.sessionService,
    isProduction: dependencies.isProduction,
  });
  const requireRecruiter = createRequireRole(['RECRUITER']);
  const sameOrigin = createRequireSameOrigin(dependencies.applicationOrigin);

  router.use(requireSession, requireRecruiter);

  // 1. Bulk upload resumes for a requisition
  router.post('/:requisitionId/resumes', sameOrigin, requireCsrf, async (request, response) => {
    const requisitionId = parseUuid(request.params['requisitionId']);
    if (!requisitionId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
      const result = await dependencies.service.uploadResumes(principal, requisitionId, request);

      const statusCode = result.acceptedCount > 0 ? 201 : 200;
      response.status(statusCode).json(result);
    } catch (error) {
      handleError(error, response);
    }
  });

  // 2. List resumes for a requisition
  router.get('/:requisitionId/resumes', async (request, response) => {
    const requisitionId = parseUuid(request.params['requisitionId']);
    if (!requisitionId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    const queryParsed = listResumesQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
      const resumes = await dependencies.service.listResumes(
        principal,
        requisitionId,
        queryParsed.data.limit,
        queryParsed.data.offset,
      );
      response.status(200).json({ resumes });
    } catch (error) {
      handleError(error, response);
    }
  });

  // 3. Get resume details
  router.get('/:requisitionId/resumes/:resumeId', async (request, response) => {
    const requisitionId = parseUuid(request.params['requisitionId']);
    const resumeId = parseUuid(request.params['resumeId']);
    if (!requisitionId || !resumeId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
      const resume = await dependencies.service.getResumeDetails(
        principal,
        requisitionId,
        resumeId,
      );
      response.status(200).json({ resume });
    } catch (error) {
      handleError(error, response);
    }
  });

  // 4. Get text extraction inspection results
  router.get('/:requisitionId/resumes/:resumeId/extraction', async (request, response) => {
    const requisitionId = parseUuid(request.params['requisitionId']);
    const resumeId = parseUuid(request.params['resumeId']);
    if (!requisitionId || !resumeId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
      const extraction = await dependencies.service.getExtraction(
        principal,
        requisitionId,
        resumeId,
      );
      response.status(200).json({ extraction });
    } catch (error) {
      handleError(error, response);
    }
  });

  // 5. Access / stream original resume file
  router.get('/:requisitionId/resumes/:resumeId/file', async (request, response) => {
    const requisitionId = parseUuid(request.params['requisitionId']);
    const resumeId = parseUuid(request.params['resumeId']);
    if (!requisitionId || !resumeId) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
      const fileData = await dependencies.service.getResumeFile(principal, requisitionId, resumeId);

      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', fileData.mimeType);
      response.setHeader('Content-Length', fileData.buffer.length);

      const safeAscii = fileData.fileName.replace(/["\r\n\\]/g, '_');
      const encodedUtf8 = encodeURIComponent(fileData.fileName);
      response.setHeader(
        'Content-Disposition',
        `inline; filename="${safeAscii}"; filename*=UTF-8''${encodedUtf8}`,
      );
      response.status(200).send(fileData.buffer);
    } catch (error) {
      handleError(error, response);
    }
  });

  // 6. Reuse an existing candidate's resume for another requisition in the same organization (F-10)
  router.post(
    '/:requisitionId/candidates/:candidateId/resumes/reuse',
    sameOrigin,
    requireCsrf,
    async (request, response) => {
      const requisitionId = parseUuid(request.params['requisitionId']);
      const candidateId = parseUuid(request.params['candidateId']);
      if (!requisitionId || !candidateId) {
        response.status(400).json({ error: 'invalid_request' });
        return;
      }

      const rawResumeDocId = (request.body as Record<string, unknown> | undefined)?.[
        'resumeDocumentId'
      ];
      let resumeDocumentId: string | undefined;
      if (rawResumeDocId !== undefined) {
        const parsedDocId = parseUuid(String(rawResumeDocId));
        if (!parsedDocId) {
          response.status(400).json({ error: 'invalid_request' });
          return;
        }
        resumeDocumentId = parsedDocId;
      }

      try {
        const principal = response.locals['authPrincipal'] as AuthenticatedPrincipal;
        const result = await dependencies.service.reuseCandidateResumeForRequisition(
          principal,
          requisitionId,
          candidateId,
          resumeDocumentId,
        );
        response.status(result.isExisting ? 200 : 201).json(result);
      } catch (error) {
        handleError(error, response);
      }
    },
  );

  return router;
}
