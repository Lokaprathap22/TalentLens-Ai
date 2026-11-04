import { getDatabaseClient, Prisma, type PrismaClient } from '@talentlens/database';
import { DocxTextExtractor, PdfTextExtractor } from './parser.js';
import { WorkerStorageService } from './storage.js';

export class WorkerJobProcessor {
  private readonly database: PrismaClient;
  private readonly storage: WorkerStorageService;
  private readonly pdfExtractor: PdfTextExtractor;
  private readonly docxExtractor: DocxTextExtractor;

  constructor(database: PrismaClient = getDatabaseClient(), storage = new WorkerStorageService()) {
    this.database = database;
    this.storage = storage;
    this.pdfExtractor = new PdfTextExtractor();
    this.docxExtractor = new DocxTextExtractor();
  }

  public async processNextJob(): Promise<boolean> {
    // 1. Short transaction: claim job atomically with backoff
    const claimed = await this.database.$transaction(async (tx) => {
      const jobs = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`
          SELECT id FROM "processing_jobs"
          WHERE (status = 'QUEUED')
             OR (
               status = 'RETRYABLE_FAILURE'
               AND attempts < 3
               AND (
                 (attempts = 1 AND updated_at + INTERVAL '30 seconds' <= NOW())
                 OR
                 (attempts = 2 AND updated_at + INTERVAL '120 seconds' <= NOW())
               )
             )
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      );

      if (!jobs || jobs.length === 0 || !jobs[0]) {
        return null;
      }

      const jobId = jobs[0].id;
      const claimedRecord = await tx.processingJob.update({
        where: { id: jobId },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          attempts: { increment: 1 },
        },
        include: {
          resumeDocument: {
            select: { id: true, objectKey: true, fileType: true, organizationId: true },
          },
        },
      });

      if (!claimedRecord.resumeDocument) {
        await tx.processingJob.update({
          where: { id: jobId },
          data: { status: 'FAILED', lastErrorCode: 'MISSING_RESUME_DOCUMENT' },
        });
        return null;
      }

      return claimedRecord;
    });

    if (!claimed || !claimed.resumeDocument) {
      if (claimed && !claimed.resumeDocument) {
        await this.database.processingJob.update({
          where: { id: claimed.id },
          data: {
            status: 'FAILED',
            lastErrorCode: 'Missing associated resume document for extraction job',
            finishedAt: new Date(),
          },
        });
      }
      return false;
    }

    const resumeDoc = claimed.resumeDocument;

    // 2. Outside transaction: read document from storage and parse
    try {
      const fileBuffer = await this.storage.read(resumeDoc.objectKey);
      const result =
        resumeDoc.fileType === 'PDF'
          ? await this.pdfExtractor.parse(fileBuffer)
          : await this.docxExtractor.parse(fileBuffer);

      // 3. Short transaction: complete job idempotently
      await this.database.$transaction(async (tx) => {
        const current = await tx.processingJob.findUnique({
          where: { id: claimed.id },
          select: { status: true },
        });
        if (current?.status === 'SUCCEEDED') {
          return;
        }

        const latest = await tx.documentExtraction.aggregate({
          where: {
            resumeDocumentId: resumeDoc.id,
            organizationId: resumeDoc.organizationId,
          },
          _max: { version: true },
        });

        const nextVersion = (latest._max.version ?? 0) + 1;

        await tx.documentExtraction.create({
          data: {
            organizationId: resumeDoc.organizationId,
            resumeDocumentId: resumeDoc.id,
            version: nextVersion,
            extractedText: result.extractedText,
            pageMapJson: result.pageMapJson as Prisma.InputJsonValue,
            parser: result.parser,
            ocrUsed: result.ocrUsed,
            qualityStatus: result.qualityStatus,
          },
        });

        const parseStatus =
          result.qualityStatus === 'COMPLETE'
            ? 'PARSED'
            : result.qualityStatus === 'NEEDS_REVIEW'
              ? 'NEEDS_REVIEW'
              : 'FAILED';

        await tx.resumeDocument.update({
          where: { id: resumeDoc.id },
          data: { parseStatus },
        });

        await tx.processingJob.update({
          where: { id: claimed.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        });
      });

      return true;
    } catch (err: unknown) {
      // 4. Short transaction: record failure and schedule retry
      const errorMessage = (err as Error).message || 'Parsing failed';
      const willFail = claimed.attempts >= 3;

      await this.database.$transaction(async (tx) => {
        await tx.processingJob.update({
          where: { id: claimed.id },
          data: {
            status: willFail ? 'FAILED' : 'RETRYABLE_FAILURE',
            lastErrorCode: errorMessage.slice(0, 500),
            finishedAt: new Date(),
          },
        });

        if (willFail) {
          await tx.resumeDocument.update({
            where: { id: resumeDoc.id },
            data: { parseStatus: 'FAILED' },
          });
        }
      });

      return true;
    }
  }
}
