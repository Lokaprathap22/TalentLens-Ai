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
  return new File([new Uint8Array(11 * 1024 * 1024)], name, { type: 'application/pdf' });
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

  it('4. validates oversized file (> 10MB) and disables upload', async () => {
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
    expect(screen.getByText(/exceeds the 10 MB limit/i)).toBeInTheDocument();
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

  it('7. displays error when batch exceeds 10 files limit', async () => {
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
    const elevenFiles = Array.from({ length: 11 }, (_, i) => makePdfFile(`cv_${i}.pdf`));

    await user.upload(input, elevenFiles);

    expect(screen.getByRole('alert')).toHaveTextContent(/at most 10 files per batch/i);
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
      expect(uploadSpy).toHaveBeenCalledWith(REQUISITION_ID, [file1, file2]);
    });

    await waitFor(() => {
      expect(screen.getByText(/Upload complete/i)).toBeInTheDocument();
    });

    const summary = screen.getByRole('status');
    expect(summary).toHaveTextContent(/1 file accepted/i);
    expect(summary).toHaveTextContent(/1 duplicate skipped/i);
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
});
