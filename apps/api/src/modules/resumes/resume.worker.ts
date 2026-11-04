import type { ResumeRepository } from './resume.repository.js';
import { createResumeRepository } from './resume.repository.js';
import type { DocumentStorageService } from './resume.types.js';
import { createDocumentStorageService } from './resume.storage.js';
import { createResumeParsingService, type ResumeParsingService } from './resume.parser.js';

export interface ResumeWorkerDependencies {
  repository?: ResumeRepository;
  storageService?: DocumentStorageService;
  parserService?: ResumeParsingService;
}

export class ResumeWorkerProcessor {
  private readonly repository: ResumeRepository;
  private readonly storageService: DocumentStorageService;
  private readonly parserService: ResumeParsingService;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(dependencies: ResumeWorkerDependencies = {}) {
    this.repository = dependencies.repository ?? createResumeRepository();
    this.storageService = dependencies.storageService ?? createDocumentStorageService();
    this.parserService = dependencies.parserService ?? createResumeParsingService();
  }

  /**
   * Atomically claims and processes the single oldest queued job.
   * Returns true if a job was processed; false if no jobs were pending.
   */
  public async processNextJob(): Promise<boolean> {
    const job = await this.repository.claimNextProcessingJob();
    if (!job) {
      return false;
    }

    try {
      // 1. Read document from safe storage
      const fileBuffer = await this.storageService.read(job.resumeDocument.objectKey);

      // 2. Parse text, page/paragraph mapping, and quality status
      const result = await this.parserService.parse(fileBuffer, job.resumeDocument.fileType);

      // 3. Persist extraction and complete the job
      await this.repository.completeProcessingJob(
        job.id,
        job.resumeDocumentId,
        job.organizationId,
        result,
      );

      return true;
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown parsing error';

      await this.repository.failProcessingJob(
        job.id,
        job.resumeDocumentId,
        errorMessage,
        false, // will become permanent if attempts >= 3
      );

      return true;
    }
  }

  /**
   * Continuous polling loop for standalone worker execution.
   */
  public start(pollIntervalMs = 2000): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        let hasMore = true;
        while (hasMore && this.isRunning) {
          hasMore = await this.processNextJob();
        }
      } catch (err) {
        // Log sanitized error without leaking document text or credentials
        console.error('Resume worker polling encountered an error:', (err as Error).message);
      } finally {
        if (this.isRunning) {
          this.timer = setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    void poll();
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export function createResumeWorkerProcessor(
  dependencies: ResumeWorkerDependencies = {},
): ResumeWorkerProcessor {
  return new ResumeWorkerProcessor(dependencies);
}
