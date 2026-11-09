import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api-client.js';
import * as candidateApi from './candidate.api.js';
import { ResumeUploadDialog } from './ResumeUploadDialog.js';
import type { ResumeBatchUploadResult } from './types.js';

const REQUISITION_ID = 'b0000000-0000-4000-8000-000000000001';

function makePdfFile(name = 'resume.pdf', size = 1024): File {
  return new File([new Uint8Array(size).fill(37)], name, { type: 'application/pdf' });
}

function makeDocxFile(name = 'resume.docx', size = 1024): File {
  return new File([new Uint8Array(size).fill(0)], name, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function makeTxtFile(name = 'resume.txt'): File {
  return new File(['plain text'], name, { type: 'text/plain' });
}

function makeHugeFile(name = 'huge.pdf'): File {
  return new File([new Uint8Array(16 * 1024 * 1024)], name, { type: 'application/pdf' });
}

const mockBatchResult: ResumeBatchUploadResult = {
  batchId: 'batch-123',
  totalFiles: 2,
  acceptedCount: 1,
  duplicateCount: 1,
  rejectedCount: 0,
  accepted: [
    {
      resumeDocumentId: 'doc-1',
      candidateId: 'cand-1',
      candidateCode: 'CAN-11111111',
      fileName: 'valid1.pdf',
      fileType: 'PDF',
      sizeBytes: 1024,
      sha256: 'hash1',
      status: 'ACCEPTED',
    },
  ],
  duplicates: [
    {
      fileName: 'duplicate.docx',
      sha256: 'hash2',
      resumeDocumentId: 'doc-existing',
      status: 'DUPLICATE',
      message: 'Already uploaded',
    },
  ],
  rejected: [],
};

describe('ResumeUploadDialog', () => {
  const onClose = vi.fn();
  const onUploadSuccess = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    onClose.mockReset();
    onUploadSuccess.mockReset();
  });

  it('1. renders dialog elements when open', () => {
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Upload resumes' })).toBeInTheDocument();
    expect(screen.getByText(/Drag and drop resumes here/i)).toBeInTheDocument();
    expect(screen.getByText(/PDF or DOCX only/i)).toBeInTheDocument();
  });

  it('2. adds valid files and shows file list with count', async () => {
    const user = userEvent.setup();
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const file1 = makePdfFile('engineer_cv.pdf');
    const file2 = makeDocxFile('designer_cv.docx');

    await user.upload(input, [file1, file2]);

    expect(screen.getByText('engineer_cv.pdf')).toBeInTheDocument();
    expect(screen.getByText('designer_cv.docx')).toBeInTheDocument();
    expect(screen.getByText(/2 files selected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload 2 files/i })).toBeEnabled();
  });

  it('3. validates unsupported extension and marks file as invalid', async () => {
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const badFile = makeTxtFile('unsupported.txt');

    // Use fireEvent.change to simulate selecting file bypassing OS filter dialog
    fireEvent.change(input, { target: { files: [badFile] } });

    expect(screen.getByText('unsupported.txt')).toBeInTheDocument();
    expect(screen.getByText(/not a supported format/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload files/i })).toBeDisabled();
  });

  it('4. validates oversized file (> 15MB) and disables upload', async () => {
    const user = userEvent.setup();
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const huge = makeHugeFile('too_big.pdf');

    await user.upload(input, [huge]);

    expect(screen.getByText('too_big.pdf')).toBeInTheDocument();
    expect(screen.getByText(/exceeds the 15 MB limit/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Upload files/i })).toBeDisabled();
  });

  it('5. allows removing a file from the selected list', async () => {
    const user = userEvent.setup();
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const file = makePdfFile('removable.pdf');

    await user.upload(input, [file]);
    expect(screen.getByText('removable.pdf')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /Remove removable\.pdf/i });
    await user.click(removeBtn);

    expect(screen.queryByText('removable.pdf')).not.toBeInTheDocument();
  });

  it('6. prevents duplicate file selection by fingerprint', async () => {
    const user = userEvent.setup();
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const file = makePdfFile('duplicate_candidate.pdf');

    await user.upload(input, [file]);
    await user.upload(input, [file]);

    expect(screen.getByText(/1 file selected/i)).toBeInTheDocument();
  });

  it('7. displays error when batch exceeds 500 files limit', async () => {
    const user = userEvent.setup();
    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const tooManyFiles = Array.from({ length: 501 }, (_, i) => makePdfFile(`cv_${i}.pdf`));

    await user.upload(input, tooManyFiles);

    expect(screen.getByRole('alert')).toHaveTextContent(/at most 500 files per batch/i);
    expect(screen.getByRole('button', { name: /Upload/i })).toBeDisabled();
  });

  it('8. executes upload successfully, maps results, and calls onUploadSuccess', async () => {
    const user = userEvent.setup();
    const uploadSpy = vi
      .spyOn(candidateApi, 'uploadResumes')
      .mockResolvedValueOnce(mockBatchResult);

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    const file1 = makePdfFile('valid1.pdf');
    const file2 = makeDocxFile('duplicate.docx');

    await user.upload(input, [file1, file2]);

    const uploadButton = screen.getByRole('button', { name: /Upload 2 files/i });
    await user.click(uploadButton);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledWith(REQUISITION_ID, [file1, file2], {
        isFinal: true,
        onProgress: expect.any(Function),
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Upload complete/i)).toBeInTheDocument();
    });

    const summary = screen.getByRole('status');
    expect(summary).toHaveTextContent(/1 file accepted/i);
    expect(summary).toHaveTextContent(/1 duplicate skipped/i);
    expect(summary).toHaveTextContent(/Batch finalized for processing/i);
    expect(onUploadSuccess).toHaveBeenCalledWith(mockBatchResult.accepted, mockBatchResult);
  });

  it('9. handles upload failure and displays human error message with retry ability', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'uploadResumes').mockRejectedValueOnce(
      new ApiError({
        status: 413,
        code: 'file_too_large',
        message: 'File too large',
      }),
    );

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [makePdfFile('resume.pdf')]);

    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/exceed the maximum size/i);
    });

    // Slots revert to pending for retry
    expect(screen.getByRole('button', { name: /Upload 1 file/i })).toBeEnabled();
  });

  it('10. preserves accepted slots on partial chunk failure and retries only failed slots with same batchId', async () => {
    const user = userEvent.setup();
    const file1 = makePdfFile('chunk1-a.pdf');
    const file2 = makePdfFile('chunk1-b.pdf');
    const file3 = makePdfFile('chunk2-fail.pdf');

    const chunkError = new candidateApi.UploadChunkError({
      message: 'Gateway timeout on chunk 2',
      status: 504,
      code: 'gateway_timeout',
      batchId: 'batch-partial-999',
      aggregateAccepted: [
        {
          clientFileId: 'slot-1',
          resumeDocumentId: 'doc-1',
          candidateId: 'c-1',
          candidateCode: 'CAN-1',
          fileName: 'chunk1-a.pdf',
          fileType: 'PDF',
          sizeBytes: 100,
          sha256: 'sha1',
          status: 'ACCEPTED',
        },
        {
          clientFileId: 'slot-2',
          resumeDocumentId: 'doc-2',
          candidateId: 'c-2',
          candidateCode: 'CAN-2',
          fileName: 'chunk1-b.pdf',
          fileType: 'PDF',
          sizeBytes: 100,
          sha256: 'sha2',
          status: 'ACCEPTED',
        },
      ],
      aggregateDuplicates: [],
      aggregateRejected: [],
      failedChunkIndex: 1,
    });

    const uploadSpy = vi
      .spyOn(candidateApi, 'uploadResumes')
      .mockRejectedValueOnce(chunkError)
      .mockResolvedValueOnce({
        batchId: 'batch-partial-999',
        totalFiles: 1,
        acceptedCount: 1,
        duplicateCount: 0,
        rejectedCount: 0,
        accepted: [
          {
            clientFileId: 'slot-3',
            resumeDocumentId: 'doc-3',
            candidateId: 'c-3',
            candidateCode: 'CAN-3',
            fileName: 'chunk2-fail.pdf',
            fileType: 'PDF',
            sizeBytes: 100,
            sha256: 'sha3',
            status: 'ACCEPTED',
          },
        ],
        duplicates: [],
        rejected: [],
      });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [file1, file2, file3]);

    await user.click(screen.getByRole('button', { name: /Upload 3 files/i }));

    // After chunk error, chunk 1 files must be Accepted (CAN-1, CAN-2) and NOT wiped
    await waitFor(() => {
      expect(screen.getByText(/Accepted · CAN-1/i)).toBeInTheDocument();
      expect(screen.getByText(/Accepted · CAN-2/i)).toBeInTheDocument();
    });

    // Only failed slot triggers retry button
    const retryBtn = screen.getByRole('button', { name: /Retry failed \(1\)/i });
    await user.click(retryBtn);

    // Trigger upload of the remaining failed slot
    const uploadRetryBtn = screen.getByRole('button', { name: /Upload 1 file/i });
    await user.click(uploadRetryBtn);

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(2);
      // Second call uses preserved batchId and marks final inside options object
      expect(uploadSpy.mock.calls[1]?.[1]).toEqual([file3]);
      expect(uploadSpy.mock.calls[1]?.[2]).toEqual({
        batchId: 'batch-partial-999',
        isFinal: true,
        onProgress: expect.any(Function),
      });
    });

    // All 3 are accepted
    await waitFor(() => {
      expect(screen.getByText(/Accepted · CAN-3/i)).toBeInTheDocument();
      expect(screen.getByText(/Accepted · CAN-1/i)).toBeInTheDocument();
    });
  });

  it('11. correlates same-name files with different content via unique clientFileId', async () => {
    const user = userEvent.setup();
    const resumeA = makePdfFile('resume.pdf');
    const resumeB = makePdfFile('resume.pdf');

    const uploadSpy = vi.spyOn(candidateApi, 'uploadResumes').mockResolvedValueOnce({
      batchId: 'batch-same-name',
      totalFiles: 2,
      acceptedCount: 1,
      duplicateCount: 1,
      rejectedCount: 0,
      accepted: [
        {
          clientFileId: 'slot-1',
          resumeDocumentId: 'doc-a',
          candidateId: 'cand-a',
          candidateCode: 'CAN-SAME-A',
          fileName: 'resume.pdf',
          fileType: 'PDF',
          sizeBytes: 100,
          sha256: 'sha-a',
          status: 'ACCEPTED',
        },
      ],
      duplicates: [
        {
          clientFileId: 'slot-2',
          fileName: 'resume.pdf',
          sha256: 'sha-a',
          resumeDocumentId: 'doc-a',
          status: 'DUPLICATE',
          message: 'Duplicate',
        },
      ],
      rejected: [],
    });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [resumeA, resumeB]);

    expect(screen.getByText(/2 files selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Upload 2 files/i }));

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Accepted · CAN-SAME-A/i)).toBeInTheDocument();
      expect(screen.getByText('Duplicate')).toBeInTheDocument();
    });
  });

  it('12. resets batchId when retrying server-rejected files after batch finalization to avoid 409', async () => {
    const user = userEvent.setup();
    const fileOk = makePdfFile('good.pdf');
    const fileBad = makePdfFile('bad.pdf');

    const uploadSpy = vi
      .spyOn(candidateApi, 'uploadResumes')
      .mockResolvedValueOnce({
        batchId: 'batch-closed-with-errors',
        totalFiles: 2,
        acceptedCount: 1,
        duplicateCount: 0,
        rejectedCount: 1,
        accepted: [
          {
            clientFileId: 'slot-1',
            resumeDocumentId: 'doc-1',
            candidateId: 'cand-1',
            candidateCode: 'CAN-OK1',
            fileName: 'good.pdf',
            fileType: 'PDF',
            sizeBytes: 100,
            sha256: 'sha-ok',
            status: 'ACCEPTED',
          },
        ],
        duplicates: [],
        rejected: [
          {
            clientFileId: 'slot-2',
            fileName: 'bad.pdf',
            reason: 'Corrupt header',
            status: 'REJECTED',
          },
        ],
      })
      .mockResolvedValueOnce({
        batchId: 'batch-retry-fresh',
        totalFiles: 1,
        acceptedCount: 1,
        duplicateCount: 0,
        rejectedCount: 0,
        accepted: [
          {
            clientFileId: 'slot-2',
            resumeDocumentId: 'doc-2',
            candidateId: 'cand-2',
            candidateCode: 'CAN-OK2',
            fileName: 'bad.pdf',
            fileType: 'PDF',
            sizeBytes: 100,
            sha256: 'sha-ok2',
            status: 'ACCEPTED',
          },
        ],
        duplicates: [],
        rejected: [],
      });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [fileOk, fileBad]);
    await user.click(screen.getByRole('button', { name: /Upload 2 files/i }));

    await waitFor(() => {
      expect(screen.getByText(/Batch finalized for processing/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Retry failed \(1\)/i }));
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(uploadSpy).toHaveBeenCalledTimes(2);
      expect(uploadSpy.mock.calls[1]?.[2]).toEqual({
        isFinal: true,
        onProgress: expect.any(Function),
      });
    });
  });

  it('13. finalizes open partial batch on Close after UploadChunkError if failed slot is not retried', async () => {
    const user = userEvent.setup();
    const finalizeSpy = vi
      .spyOn(candidateApi, 'finalizeResumeBatch')
      .mockResolvedValueOnce({ id: 'batch-partial-open', status: 'PROCESSING', isOpen: false });

    vi.spyOn(candidateApi, 'uploadResumes').mockRejectedValueOnce(
      new candidateApi.UploadChunkError({
        message: 'Chunk 2 interrupted',
        status: 504,
        batchId: 'batch-partial-open',
        aggregateAccepted: [],
        aggregateDuplicates: [],
        aggregateRejected: [],
        failedChunkIndex: 1,
      }),
    );

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [makePdfFile('c1.pdf')]);
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Chunk 2 interrupted/i).length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: /^Close$/i }));

    await waitFor(() => {
      expect(finalizeSpy).toHaveBeenCalledWith(REQUISITION_ID, 'batch-partial-open');
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('14. surfaces explicit API finalization failure after upload succeeds without re-uploading or falsely marking finalized', async () => {
    const user = userEvent.setup();
    const file1 = makePdfFile('chunk1-a.pdf');
    const file2 = makePdfFile('chunk1-b.pdf');
    const file3 = makePdfFile('chunk2-dup.pdf');

    const uploadSpy = vi
      .spyOn(candidateApi, 'uploadResumes')
      .mockRejectedValueOnce(
        new candidateApi.UploadChunkError({
          message: 'Chunk 2 interrupted',
          status: 504,
          code: 'gateway_timeout',
          batchId: 'batch-partial-err',
          aggregateAccepted: [
            {
              clientFileId: 'slot-1',
              resumeDocumentId: 'doc-1',
              candidateId: 'c-1',
              candidateCode: 'CAN-KEEP-1',
              fileName: 'chunk1-a.pdf',
              fileType: 'PDF',
              sizeBytes: 100,
              sha256: 'sha1',
              status: 'ACCEPTED',
            },
            {
              clientFileId: 'slot-2',
              resumeDocumentId: 'doc-2',
              candidateId: 'c-2',
              candidateCode: 'CAN-KEEP-2',
              fileName: 'chunk1-b.pdf',
              fileType: 'PDF',
              sizeBytes: 100,
              sha256: 'sha2',
              status: 'ACCEPTED',
            },
          ],
          aggregateDuplicates: [],
          aggregateRejected: [],
          failedChunkIndex: 1,
        }),
      )
      .mockResolvedValueOnce({
        batchId: null,
        totalFiles: 1,
        acceptedCount: 0,
        duplicateCount: 1,
        rejectedCount: 0,
        accepted: [],
        duplicates: [
          {
            clientFileId: 'slot-3',
            fileName: 'chunk2-dup.pdf',
            sha256: 'sha1',
            resumeDocumentId: 'doc-1',
            status: 'DUPLICATE',
            message: 'Already exists',
          },
        ],
        rejected: [],
      });

    const finalizeSpy = vi
      .spyOn(candidateApi, 'finalizeResumeBatch')
      .mockRejectedValueOnce(
        new ApiError({
          status: 503,
          code: 'service_unavailable',
          message: 'Finalization failed on server',
        }),
      )
      .mockResolvedValueOnce({
        id: 'batch-partial-err',
        status: 'PROCESSING',
        isOpen: false,
      });

    const statusSpy = vi.spyOn(candidateApi, 'getResumeBatchStatus').mockResolvedValue({
      id: 'batch-partial-err',
      status: 'PROCESSING',
      isOpen: true,
    });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [file1, file2, file3]);
    await user.click(screen.getByRole('button', { name: /Upload 3 files/i }));

    await waitFor(() => {
      expect(screen.getByText(/Accepted · CAN-KEEP-1/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Retry failed \(1\)/i }));
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
    });

    // Must NEVER falsely show finalized, must preserve accepted slots, and must show retry finalization button
    expect(screen.queryByText(/Batch finalized for processing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Accepted · CAN-KEEP-1/i)).toBeInTheDocument();
    expect(screen.getByText(/Accepted · CAN-KEEP-2/i)).toBeInTheDocument();

    // Retry finalization ONLY — must NOT re-upload any files
    await user.click(screen.getByRole('button', { name: /Finalize batch/i }));

    await waitFor(() => {
      expect(statusSpy).toHaveBeenCalledWith(REQUISITION_ID, 'batch-partial-err');
      expect(finalizeSpy).toHaveBeenCalledTimes(2);
      expect(uploadSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByText(/Batch finalized for processing/i)).toBeInTheDocument();
    });
  });

  it('15. reconciles server-finalized state when network response is lost and avoids duplicate finalize POST on retry', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'uploadResumes').mockRejectedValueOnce(
      new candidateApi.UploadChunkError({
        message: 'Chunk interrupted',
        status: 504,
        batchId: 'batch-lost-response',
        aggregateAccepted: [],
        aggregateDuplicates: [],
        aggregateRejected: [],
        failedChunkIndex: 1,
      }),
    );

    // Finalize loses network response AND immediate status probe also fails offline
    const finalizeSpy = vi.spyOn(candidateApi, 'finalizeResumeBatch').mockRejectedValueOnce(
      new ApiError({
        status: 0,
        code: 'network_error',
        message: 'Network connection lost',
      }),
    );
    const statusSpy = vi
      .spyOn(candidateApi, 'getResumeBatchStatus')
      .mockRejectedValueOnce(
        new ApiError({
          status: 0,
          code: 'network_error',
          message: 'Still offline',
        }),
      )
      .mockResolvedValueOnce({
        id: 'batch-lost-response',
        status: 'PROCESSING',
        isOpen: false,
      });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [makePdfFile('net.pdf')]);
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Chunk interrupted/i).length).toBeGreaterThan(0);
    });

    // Clicking Close triggers finalization, which fails with network error — must NOT swallow error or close
    await user.click(screen.getByRole('button', { name: /^Close$/i }));

    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts[0]).toHaveTextContent(/Check your connection/i);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Batch finalized for processing/i)).not.toBeInTheDocument();

    // Clicking Finalize batch checks server state first -> sees isOpen: false -> reconciles without duplicate POST!
    await user.click(screen.getByRole('button', { name: /Finalize batch/i }));

    await waitFor(() => {
      expect(statusSpy).toHaveBeenCalledTimes(2);
      expect(finalizeSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Batch finalized for processing/i)).toBeInTheDocument();
    });
  });

  it('15b. keeps local state unfinalized on network error during finalization when server batch remains open', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'uploadResumes').mockRejectedValueOnce(
      new candidateApi.UploadChunkError({
        message: 'Chunk 2 interrupted',
        status: 504,
        batchId: 'batch-still-open',
        aggregateAccepted: [],
        aggregateDuplicates: [],
        aggregateRejected: [],
        failedChunkIndex: 1,
      }),
    );

    vi.spyOn(candidateApi, 'finalizeResumeBatch').mockRejectedValueOnce(
      new ApiError({
        status: 0,
        code: 'network_error',
        message: 'Network failure during finalization',
      }),
    );
    vi.spyOn(candidateApi, 'getResumeBatchStatus').mockResolvedValueOnce({
      id: 'batch-still-open',
      status: 'PROCESSING',
      isOpen: true,
    });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [makePdfFile('open.pdf')]);
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Chunk 2 interrupted/i).length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole('button', { name: /^Close$/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/Check your connection/i);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Batch finalized for processing/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close without finalizing/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Finalize batch/i })).toBeEnabled();
  });

  it('16. refuses to mark batch finalized when server returns missing or malformed batchId', async () => {
    const user = userEvent.setup();
    vi.spyOn(candidateApi, 'uploadResumes').mockResolvedValueOnce({
      batchId: '   ',
      totalFiles: 1,
      acceptedCount: 1,
      duplicateCount: 0,
      rejectedCount: 0,
      accepted: [
        {
          clientFileId: 'slot-1',
          resumeDocumentId: 'doc-1',
          candidateId: 'c-1',
          candidateCode: 'CAN-BAD-ID',
          fileName: 'malformed.pdf',
          fileType: 'PDF',
          sizeBytes: 100,
          sha256: 'sha1',
          status: 'ACCEPTED',
        },
      ],
      duplicates: [],
      rejected: [],
    });

    render(
      <ResumeUploadDialog
        open={true}
        requisitionId={REQUISITION_ID}
        onClose={onClose}
        onUploadSuccess={onUploadSuccess}
      />,
    );

    const input = screen.getByLabelText(/Select resume files to upload/i);
    await user.upload(input, [makePdfFile('malformed.pdf')]);
    await user.click(screen.getByRole('button', { name: /Upload 1 file/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/missing or malformed batch identifier/i);
    });
    expect(screen.queryByText(/Batch finalized for processing/i)).not.toBeInTheDocument();
  });
});
