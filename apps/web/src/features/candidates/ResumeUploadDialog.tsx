/**
 * ResumeUploadDialog — Bulk resume upload modal for the Recruiter workspace.
 *
 * Security invariants:
 * - Never logs file contents, candidate codes, or extracted text.
 * - Never sets Content-Type manually on FormData; apiClient handles boundary.
 * - Duplicate submission is prevented by an uploading guard ref.
 * - Client-side validation is UX-only; backend performs definitive MIME/magic-bytes validation.
 * - No fixture or mock data inserted into the production upload path.
 * - After upload, the parent is notified of accepted results to update the directory.
 */

import { AlertCircle, CheckCircle2, Copy, FileText, FileX, Loader, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Icon } from '../../components/ui/icon.js';
import { cn } from '../../lib/cn.js';
import {
  UPLOAD_ACCEPTED_TYPES_LABEL,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
  resolveUploadErrorMessage,
  uploadResumes,
  validateUploadFile,
} from './candidate.api.js';
import type { AcceptedUploadItem, ResumeBatchUploadResult, UploadSlot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let slotIdCounter = 0;
function nextSlotId(): string {
  return `slot-${++slotIdCounter}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ResumeUploadDialogProps {
  open: boolean;
  requisitionId: string;
  onClose: () => void;
  /**
   * Called with backend-confirmed accepted items after a successful upload.
   * The parent should optimistically prepend these to its candidate list
   * and then perform a server reload for reconciliation.
   */
  onUploadSuccess: (accepted: AcceptedUploadItem[], result: ResumeBatchUploadResult) => void;
}

// ---------------------------------------------------------------------------
// File row component
// ---------------------------------------------------------------------------

interface SlotRowProps {
  slot: UploadSlot;
  onRemove: (slotId: string) => void;
  removing: boolean;
}

function SlotRow({ slot, onRemove, removing }: SlotRowProps): React.JSX.Element {
  const { file, status, validationError, serverResult, errorMessage } = slot;
  const sizeLabel = formatBytes(file.size);

  const statusIcon = (): React.JSX.Element => {
    switch (status) {
      case 'uploading':
        return (
          <span
            className="size-4 animate-spin rounded-full border-2 border-fg-disabled border-t-info-solid"
            aria-label="Uploading"
          />
        );
      case 'accepted':
        return (
          <Icon icon={CheckCircle2} size="sm" className="text-success" aria-label="Accepted" />
        );
      case 'duplicate':
        return <Icon icon={Copy} size="sm" className="text-warning" aria-label="Duplicate" />;
      case 'rejected':
        return <Icon icon={FileX} size="sm" className="text-danger" aria-label="Rejected" />;
      case 'error':
        return <Icon icon={AlertCircle} size="sm" className="text-danger" aria-label="Error" />;
      case 'invalid':
        return <Icon icon={AlertCircle} size="sm" className="text-warning" aria-label="Invalid" />;
      default:
        return <Icon icon={FileText} size="sm" className="text-fg-subtle" />;
    }
  };

  const statusLabel = (): React.JSX.Element | null => {
    switch (status) {
      case 'uploading':
        return <Badge tone="info">Uploading…</Badge>;
      case 'accepted':
        return (
          <Badge tone="success">
            Accepted{' '}
            {serverResult && 'candidateCode' in serverResult
              ? `· ${serverResult.candidateCode}`
              : ''}
          </Badge>
        );
      case 'duplicate':
        return <Badge tone="warning">Duplicate</Badge>;
      case 'rejected':
        return (
          <Badge tone="danger">
            Rejected
            {serverResult && 'reason' in serverResult && serverResult.reason
              ? ` · ${serverResult.reason}`
              : ''}
          </Badge>
        );
      case 'error':
        return <Badge tone="danger">Upload error</Badge>;
      case 'invalid':
        return <Badge tone="warning">Invalid file</Badge>;
      default:
        return null;
    }
  };

  const isTerminal = status === 'accepted' || status === 'duplicate' || status === 'rejected';
  const isRemovable = !isTerminal && status !== 'uploading';

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <span className="mt-0.5 shrink-0">{statusIcon()}</span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg" title={file.name}>
          {file.name}
        </p>
        <p className="mt-0.5 text-xs text-fg-subtle">{sizeLabel}</p>
        {(validationError ?? errorMessage) ? (
          <p className="mt-1 text-xs text-danger" role="alert">
            {validationError ?? errorMessage}
          </p>
        ) : null}
        <span className="mt-1 block">{statusLabel()}</span>
      </div>

      {isRemovable ? (
        <button
          type="button"
          onClick={() => {
            onRemove(slot.slotId);
          }}
          disabled={removing}
          aria-label={`Remove ${file.name}`}
          className="mt-0.5 shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          <Icon icon={X} size="xs" />
        </button>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

export function ResumeUploadDialog({
  open,
  requisitionId,
  onClose,
  onUploadSuccess,
}: ResumeUploadDialogProps): React.JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const uploadingRef = useRef(false);
  const dropActiveRef = useRef(false);
  const dropZoneId = useId();
  const fileListId = useId();

  const [slots, setSlots] = useState<UploadSlot[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [uploadResult, setUploadResult] = useState<ResumeBatchUploadResult | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      // Only reset if not mid-upload
      if (!uploadingRef.current) {
        setSlots([]);
        setBatchError(null);
        setUploadPhase('idle');
        setUploadResult(null);
        setIsDragOver(false);
        slotIdCounter = 0;
      }
    }
  }, [open]);

  const addFiles = useCallback((incomingFiles: FileList | File[]): void => {
    setBatchError(null);
    const incoming = Array.from(incomingFiles);

    setSlots((prev) => {
      // De-duplicate by name+size fingerprint to prevent duplicate selections
      const existingFingerprints = new Set(prev.map((s) => `${s.file.name}:${s.file.size}`));

      const toAdd: UploadSlot[] = [];
      for (const file of incoming) {
        const fp = `${file.name}:${file.size}`;
        if (existingFingerprints.has(fp)) {
          continue; // Skip already-selected file
        }
        existingFingerprints.add(fp);

        const validationError = validateUploadFile(file) ?? undefined;
        toAdd.push({
          slotId: nextSlotId(),
          file,
          status: validationError ? 'invalid' : 'pending',
          validationError,
        });
      }

      const next = [...prev, ...toAdd];

      // Check total batch size after adding
      const validCount = next.filter((s) => s.status !== 'invalid').length;
      if (validCount > UPLOAD_MAX_FILES) {
        setBatchError(
          `You can upload at most ${UPLOAD_MAX_FILES} files per batch. Remove some files before uploading.`,
        );
      }

      return next;
    });
  }, []);

  const handleFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      const files = event.target.files;
      if (files && files.length > 0) {
        addFiles(files);
      }
      // Reset input so the same file can be re-selected after removal
      event.target.value = '';
    },
    [addFiles],
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!dropActiveRef.current) {
      dropActiveRef.current = true;
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    // Only treat as leave when cursor leaves the drop zone entirely
    if (dropZoneRef.current && !dropZoneRef.current.contains(event.relatedTarget as Node)) {
      dropActiveRef.current = false;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      event.stopPropagation();
      dropActiveRef.current = false;
      setIsDragOver(false);

      const files = event.dataTransfer.files;
      if (files && files.length > 0) {
        addFiles(files);
      }
    },
    [addFiles],
  );

  const handleRemoveSlot = useCallback((slotId: string): void => {
    setSlots((prev) => prev.filter((s) => s.slotId !== slotId));
    setBatchError(null);
  }, []);

  const handleUpload = useCallback(async (): Promise<void> => {
    // Prevent double-submission
    if (uploadingRef.current) {
      return;
    }

    const pendingSlots = slots.filter((s) => s.status === 'pending');
    if (pendingSlots.length === 0) {
      setBatchError('No valid files are ready for upload.');
      return;
    }

    if (pendingSlots.length > UPLOAD_MAX_FILES) {
      setBatchError(
        `Please reduce the selection to ${UPLOAD_MAX_FILES} files or fewer before uploading.`,
      );
      return;
    }

    uploadingRef.current = true;
    setUploadPhase('uploading');
    setBatchError(null);

    // Mark all pending slots as uploading
    setSlots((prev) =>
      prev.map((s) => (s.status === 'pending' ? { ...s, status: 'uploading' as const } : s)),
    );

    try {
      const filesToUpload = pendingSlots.map((s) => s.file);
      const result = await uploadResumes(requisitionId, filesToUpload);

      setUploadResult(result);
      setUploadPhase('done');

      // Map server results back to slots by filename
      setSlots((prev) =>
        prev.map((slot) => {
          if (slot.status !== 'uploading') {
            return slot;
          }
          const name = slot.file.name;
          const accepted = result.accepted.find((a) => a.fileName === name);
          if (accepted) {
            return { ...slot, status: 'accepted' as const, serverResult: accepted };
          }
          const duplicate = result.duplicates.find((d) => d.fileName === name);
          if (duplicate) {
            return { ...slot, status: 'duplicate' as const, serverResult: duplicate };
          }
          const rejected = result.rejected.find((r) => r.fileName === name);
          if (rejected) {
            return { ...slot, status: 'rejected' as const, serverResult: rejected };
          }
          // Unexpected: file not in any result list
          return {
            ...slot,
            status: 'error' as const,
            errorMessage: 'No result returned for this file.',
          };
        }),
      );

      if (result.acceptedCount > 0) {
        onUploadSuccess(result.accepted, result);
      }
    } catch (error) {
      setUploadPhase('idle');
      setBatchError(resolveUploadErrorMessage(error));

      // Revert uploading slots to pending so they can be retried
      setSlots((prev) =>
        prev.map((s) => (s.status === 'uploading' ? { ...s, status: 'pending' as const } : s)),
      );
    } finally {
      uploadingRef.current = false;
    }
  }, [slots, requisitionId, onUploadSuccess]);

  const handleClose = useCallback((): void => {
    if (uploadingRef.current) {
      // Do not close while upload is in-flight
      return;
    }
    onClose();
  }, [onClose]);

  // Derived state
  const pendingSlots = slots.filter((s) => s.status === 'pending');
  const invalidSlots = slots.filter((s) => s.status === 'invalid');
  const hasValidPending = pendingSlots.length > 0;
  const isUploading = uploadPhase === 'uploading';
  const isDone = uploadPhase === 'done';

  const canUpload =
    hasValidPending &&
    !isUploading &&
    !isDone &&
    invalidSlots.length === 0 &&
    pendingSlots.length <= UPLOAD_MAX_FILES;

  const maxMbLabel = `${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MB`;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Upload resumes"
      description={`Add up to ${UPLOAD_MAX_FILES} ${UPLOAD_ACCEPTED_TYPES_LABEL} files (max ${maxMbLabel} each) for processing.`}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={isUploading}>
            {isDone ? 'Close' : 'Cancel'}
          </Button>
          {!isDone ? (
            <Button
              variant="primary"
              onClick={() => {
                void handleUpload();
              }}
              disabled={!canUpload || isUploading}
              aria-busy={isUploading}
            >
              {isUploading ? (
                <>
                  <Icon icon={Loader} size="sm" className="animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Icon icon={Upload} size="sm" />
                  Upload{' '}
                  {pendingSlots.length > 0
                    ? `${pendingSlots.length} file${pendingSlots.length !== 1 ? 's' : ''}`
                    : 'files'}
                </>
              )}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        {/* Drop zone */}
        {!isDone ? (
          <div
            ref={dropZoneRef}
            id={dropZoneId}
            role="region"
            aria-label="File drop zone"
            aria-describedby={fileListId}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={cn(
              'flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors',
              isDragOver
                ? 'border-accent bg-accent/5 text-accent'
                : 'border-border bg-surface-muted/40 text-fg-subtle hover:border-accent/60 hover:bg-accent/5',
            )}
          >
            <Icon
              icon={Upload}
              size="lg"
              className={isDragOver ? 'text-accent' : 'text-fg-disabled'}
            />
            <div>
              <p className="text-sm font-medium text-fg">
                {isDragOver ? 'Drop files to add them' : 'Drag and drop resumes here'}
              </p>
              <p className="mt-0.5 text-xs text-fg-subtle">
                or{' '}
                <button
                  type="button"
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                  className="font-medium text-accent underline underline-offset-2 hover:text-accent/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  browse files
                </button>
              </p>
              <p className="mt-1.5 text-xs text-fg-subtle">
                {UPLOAD_ACCEPTED_TYPES_LABEL} only · max {maxMbLabel} per file · up to{' '}
                {UPLOAD_MAX_FILES} files per batch
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx"
              className="sr-only"
              onChange={handleFileInputChange}
              aria-label="Select resume files to upload"
              tabIndex={-1}
            />
          </div>
        ) : null}

        {/* Batch-level error */}
        {batchError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <span>{batchError}</span>
          </div>
        ) : null}

        {/* Invalid file count warning */}
        {invalidSlots.length > 0 && !batchError ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning"
          >
            <Icon icon={AlertCircle} size="sm" className="mt-0.5 shrink-0" />
            <span>
              {invalidSlots.length} file{invalidSlots.length !== 1 ? 's are' : ' is'} invalid and
              will not be uploaded. Remove or replace them before uploading.
            </span>
          </div>
        ) : null}

        {/* Upload result summary */}
        {isDone && uploadResult ? (
          <div
            role="status"
            className="rounded-lg border border-border bg-surface-muted/60 px-4 py-3"
          >
            <p className="text-sm font-semibold text-fg">Upload complete</p>
            <ul className="mt-2 space-y-1 text-xs text-fg-subtle">
              <li>
                <span className="font-medium text-success">{uploadResult.acceptedCount}</span> file
                {uploadResult.acceptedCount !== 1 ? 's' : ''} accepted
              </li>
              {uploadResult.duplicateCount > 0 ? (
                <li>
                  <span className="font-medium text-warning">{uploadResult.duplicateCount}</span>{' '}
                  duplicate{uploadResult.duplicateCount !== 1 ? 's' : ''} skipped
                </li>
              ) : null}
              {uploadResult.rejectedCount > 0 ? (
                <li>
                  <span className="font-medium text-danger">{uploadResult.rejectedCount}</span> file
                  {uploadResult.rejectedCount !== 1 ? 's' : ''} rejected by the server
                </li>
              ) : null}
              {uploadResult.acceptedCount === 0 ? (
                <li className="text-fg-muted">
                  No new candidates were added. All files were either duplicates or rejected.
                </li>
              ) : (
                <li className="text-fg-muted">
                  Accepted candidates have been queued for processing. Processing requires candidate
                  consent before text extraction begins.
                </li>
              )}
            </ul>
          </div>
        ) : null}

        {/* File list */}
        {slots.length > 0 ? (
          <div>
            <p
              id={fileListId}
              className="mb-2 text-xs font-medium text-fg-subtle"
              aria-live="polite"
              aria-atomic="true"
            >
              {slots.length} file{slots.length !== 1 ? 's' : ''} selected
              {pendingSlots.length > 0 ? ` · ${pendingSlots.length} ready` : ''}
            </p>
            <ul className="space-y-2" aria-label="Selected files">
              {slots.map((slot) => (
                <SlotRow
                  key={slot.slotId}
                  slot={slot}
                  onRemove={handleRemoveSlot}
                  removing={isUploading}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {/* Consent notice */}
        <div className="rounded-lg border border-info-border bg-info-soft/60 px-3 py-2.5 text-xs text-fg-subtle">
          <p className="font-medium text-fg">Consent and processing notice</p>
          <p className="mt-0.5">
            Uploaded resumes will be queued for processing. If candidate consent has not yet been
            obtained for this requisition, processing will be held until the candidate provides
            explicit consent. No resume text will be extracted or assessed until consent is active.
          </p>
        </div>
      </div>
    </Dialog>
  );
}
