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
import { ApiError, isApiError } from '../../lib/api-client.js';
import {
  UPLOAD_ACCEPTED_TYPES_LABEL,
  UPLOAD_MAX_BATCH_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
  UploadChunkError,
  finalizeResumeBatch,
  getResumeBatchStatus,
  resolveUploadErrorMessage,
  uploadResumes,
  validateUploadFile,
} from './candidate.api.js';
import type { AcceptedUploadItem, ResumeBatchUploadResult, UploadSlot } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isValidBatchIdentifier(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/[\s/?#\\]/.test(trimmed)) return false;
  if (trimmed === 'null' || trimmed === 'undefined') return false;
  return true;
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
  const needsFinalizationReconcileRef = useRef(false);
  const slotIdCounterRef = useRef(0);
  const nextSlotId = useCallback((): string => {
    return `slot-${++slotIdCounterRef.current}`;
  }, []);
  const dropZoneId = useId();
  const fileListId = useId();

  const [slots, setSlots] = useState<UploadSlot[]>([]);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [batchFinalized, setBatchFinalized] = useState(false);
  const [finalizingBatch, setFinalizingBatch] = useState(false);
  const [closeFinalizeFailed, setCloseFinalizeFailed] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [uploadPhase, setUploadPhase] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [uploadResult, setUploadResult] = useState<ResumeBatchUploadResult | null>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    uploadedCount: number;
    totalCount: number;
    percent: number;
  } | null>(null);

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      // Only reset if not mid-upload
      if (!uploadingRef.current) {
        setSlots([]);
        setActiveBatchId(null);
        setBatchFinalized(false);
        setFinalizingBatch(false);
        setCloseFinalizeFailed(false);
        setBatchError(null);
        setUploadPhase('idle');
        setUploadResult(null);
        setUploadProgress(null);
        setIsDragOver(false);
        needsFinalizationReconcileRef.current = false;
        slotIdCounterRef.current = 0;
      }
    }
  }, [open]);

  const tryFinalizeBatch = useCallback(
    async (targetBatchId: string, checkServerFirst = false): Promise<boolean> => {
      if (!isValidBatchIdentifier(targetBatchId)) {
        needsFinalizationReconcileRef.current = false;
        setBatchFinalized(false);
        throw new ApiError({
          status: 400,
          code: 'invalid_request',
          message: 'A valid batch identifier is required to finalize the upload batch.',
        });
      }

      if (checkServerFirst) {
        try {
          const status = await getResumeBatchStatus(requisitionId, targetBatchId);
          if (status.id === targetBatchId && status.isOpen === false) {
            needsFinalizationReconcileRef.current = false;
            setBatchFinalized(true);
            setBatchError(null);
            setCloseFinalizeFailed(false);
            return true;
          }
        } catch (statusErr) {
          if (
            isApiError(statusErr) &&
            (statusErr.status === 400 ||
              statusErr.status === 401 ||
              statusErr.status === 403 ||
              statusErr.status === 404)
          ) {
            throw statusErr;
          }
        }
      }

      try {
        const finalized = await finalizeResumeBatch(requisitionId, targetBatchId);
        if (!finalized || finalized.id !== targetBatchId || finalized.isOpen !== false) {
          throw new ApiError({
            status: 409,
            code: 'batch_not_finalized',
            message: 'The server did not confirm that the batch was finalized. Please retry.',
          });
        }
        needsFinalizationReconcileRef.current = false;
        setBatchFinalized(true);
        setBatchError(null);
        setCloseFinalizeFailed(false);
        return true;
      } catch (finalizeErr) {
        const mayHaveCompleted =
          !isApiError(finalizeErr) ||
          (finalizeErr.code !== 'invalid_response_format' &&
            (finalizeErr.status === 0 ||
              finalizeErr.code === 'network_error' ||
              finalizeErr.status >= 500));

        if (mayHaveCompleted) {
          try {
            const status = await getResumeBatchStatus(requisitionId, targetBatchId);
            if (status.id === targetBatchId && status.isOpen === false) {
              needsFinalizationReconcileRef.current = false;
              setBatchFinalized(true);
              setBatchError(null);
              setCloseFinalizeFailed(false);
              return true;
            }
          } catch {
            // Reconciliation failed or batch remains open — surface the original finalization error.
          }
        }

        needsFinalizationReconcileRef.current = true;
        setBatchFinalized(false);
        throw finalizeErr;
      }
    },
    [requisitionId],
  );

  const addFiles = useCallback(
    (incomingFiles: FileList | File[]): void => {
      setBatchError(null);
      const incoming = Array.from(incomingFiles);

      setSlots((prev) => {
        // Track existing File references to prevent adding the exact same file instance twice
        const existingFileSet = new Set(prev.map((s) => s.file));

        const toAdd: UploadSlot[] = [];
        for (const file of incoming) {
          if (existingFileSet.has(file)) {
            continue;
          }
          existingFileSet.add(file);

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
        } else {
          const totalBytes = next.reduce((acc, s) => acc + s.file.size, 0);
          if (totalBytes > UPLOAD_MAX_BATCH_BYTES) {
            setBatchError(
              'Total batch size exceeds 1 GB limit. Remove some files before uploading.',
            );
          }
        }

        return next;
      });
    },
    [nextSlotId],
  );

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
      const filesToUpload = pendingSlots.map((s) => {
        (s.file as File & { clientFileId?: string }).clientFileId = s.slotId;
        return s.file;
      });
      const pendingSlotIds = new Set(pendingSlots.map((s) => s.slotId));
      const hasUnresolvedOtherSlots = slots.some(
        (s) =>
          !pendingSlotIds.has(s.slotId) &&
          (s.status === 'invalid' || s.status === 'error' || s.status === 'rejected'),
      );
      const shouldFinalize = !hasUnresolvedOtherSlots;

      const result = await uploadResumes(requisitionId, filesToUpload, {
        onProgress: (progress) => {
          setUploadProgress(progress);
        },
        isFinal: shouldFinalize,
        ...(activeBatchId ? { batchId: activeBatchId } : {}),
      });

      // Commit upload results & slot statuses immediately so a follow-up finalization
      // failure never resets accepted slots to pending or triggers duplicate uploads.
      setUploadResult(result);
      setUploadPhase('done');

      // Map server results back to slots by clientFileId first, fallback to filename
      setSlots((prev) =>
        prev.map((slot) => {
          if (slot.status !== 'uploading') {
            return slot;
          }
          const accepted = result.accepted.find((a) =>
            a.clientFileId ? a.clientFileId === slot.slotId : a.fileName === slot.file.name,
          );
          if (accepted) {
            return { ...slot, status: 'accepted' as const, serverResult: accepted };
          }
          const duplicate = result.duplicates.find((d) =>
            d.clientFileId ? d.clientFileId === slot.slotId : d.fileName === slot.file.name,
          );
          if (duplicate) {
            return { ...slot, status: 'duplicate' as const, serverResult: duplicate };
          }
          const rejected = result.rejected.find((r) =>
            r.clientFileId ? r.clientFileId === slot.slotId : r.fileName === slot.file.name,
          );
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

      const returnedInvalidBatchId =
        result.batchId !== null && !isValidBatchIdentifier(result.batchId);
      const missingBatchIdForAccepted =
        result.acceptedCount > 0 && !isValidBatchIdentifier(result.batchId) && !activeBatchId;

      if (returnedInvalidBatchId || missingBatchIdForAccepted) {
        setBatchFinalized(false);
        setBatchError(
          'The server returned a missing or malformed batch identifier. Batch finalization could not be verified.',
        );
        return;
      }

      const resolvedBatchId =
        (isValidBatchIdentifier(result.batchId) ? result.batchId.trim() : null) ?? activeBatchId;

      if (resolvedBatchId) {
        setActiveBatchId(resolvedBatchId);
        if (shouldFinalize) {
          if (result.batchId === null && activeBatchId) {
            setFinalizingBatch(true);
            try {
              await tryFinalizeBatch(activeBatchId, needsFinalizationReconcileRef.current);
            } catch (finalizeError) {
              setBatchFinalized(false);
              setBatchError(resolveUploadErrorMessage(finalizeError));
            } finally {
              setFinalizingBatch(false);
            }
          } else {
            needsFinalizationReconcileRef.current = false;
            setBatchFinalized(true);
            setCloseFinalizeFailed(false);
          }
        }
      }
    } catch (error) {
      if (error instanceof UploadChunkError) {
        if (isValidBatchIdentifier(error.batchId)) {
          setActiveBatchId(error.batchId.trim());
        }
        setBatchFinalized(false);
        setUploadPhase('done');
        setBatchError(error.message);

        // Update slots: preserve accepted/duplicates/rejected from previous chunks
        setSlots((prev) =>
          prev.map((slot) => {
            if (slot.status !== 'uploading') {
              return slot;
            }
            const accepted = error.aggregateAccepted.find((a) =>
              a.clientFileId ? a.clientFileId === slot.slotId : a.fileName === slot.file.name,
            );
            if (accepted) {
              return { ...slot, status: 'accepted' as const, serverResult: accepted };
            }
            const duplicate = error.aggregateDuplicates.find((d) =>
              d.clientFileId ? d.clientFileId === slot.slotId : d.fileName === slot.file.name,
            );
            if (duplicate) {
              return { ...slot, status: 'duplicate' as const, serverResult: duplicate };
            }
            const rejected = error.aggregateRejected.find((r) =>
              r.clientFileId ? r.clientFileId === slot.slotId : r.fileName === slot.file.name,
            );
            if (rejected) {
              return { ...slot, status: 'rejected' as const, serverResult: rejected };
            }
            return {
              ...slot,
              status: 'error' as const,
              errorMessage: error.message || 'Chunk upload failed',
            };
          }),
        );

        if (error.aggregateAccepted.length > 0) {
          onUploadSuccess(error.aggregateAccepted, {
            batchId: error.batchId,
            totalFiles: slots.length,
            acceptedCount: error.aggregateAccepted.length,
            duplicateCount: error.aggregateDuplicates.length,
            rejectedCount: error.aggregateRejected.length,
            accepted: error.aggregateAccepted,
            duplicates: error.aggregateDuplicates,
            rejected: error.aggregateRejected,
          });
        }
      } else {
        setUploadPhase('idle');
        setBatchError(resolveUploadErrorMessage(error));

        // Revert uploading slots to pending so they can be retried
        setSlots((prev) =>
          prev.map((s) => (s.status === 'uploading' ? { ...s, status: 'pending' as const } : s)),
        );
      }
    } finally {
      uploadingRef.current = false;
      setUploadProgress(null);
    }
  }, [slots, requisitionId, onUploadSuccess, activeBatchId, tryFinalizeBatch]);

  const handleRetryFailed = useCallback((): void => {
    if (batchFinalized) {
      // Previous batch was already closed on the server (e.g. rejected files); start a fresh batch on retry
      setActiveBatchId(null);
      setBatchFinalized(false);
    }
    setCloseFinalizeFailed(false);
    setSlots((prev) =>
      prev.map((s) => {
        if (s.status === 'rejected' || s.status === 'error') {
          return {
            ...s,
            status: 'pending' as const,
            errorMessage: undefined,
            serverResult: undefined,
          };
        }
        return s;
      }),
    );
    setUploadPhase('idle');
    setBatchError(null);
  }, [batchFinalized]);

  const handleFinalizeOpenBatch = useCallback(async (): Promise<void> => {
    if (!activeBatchId || batchFinalized || uploadingRef.current || finalizingBatch) {
      return;
    }
    setFinalizingBatch(true);
    setBatchError(null);
    try {
      await tryFinalizeBatch(activeBatchId, needsFinalizationReconcileRef.current);
    } catch (error) {
      setBatchFinalized(false);
      setBatchError(resolveUploadErrorMessage(error));
    } finally {
      setFinalizingBatch(false);
    }
  }, [activeBatchId, batchFinalized, finalizingBatch, tryFinalizeBatch]);

  const handleClose = useCallback(async (): Promise<void> => {
    if (uploadingRef.current || finalizingBatch) {
      // Do not close while upload or finalization is in-flight
      return;
    }
    if (activeBatchId && !batchFinalized) {
      setFinalizingBatch(true);
      setBatchError(null);
      try {
        await tryFinalizeBatch(activeBatchId, needsFinalizationReconcileRef.current);
      } catch (error) {
        setBatchFinalized(false);
        setCloseFinalizeFailed(true);
        setBatchError(
          `${resolveUploadErrorMessage(error)} You can retry "Finalize batch" or click "Close without finalizing".`,
        );
        return;
      } finally {
        setFinalizingBatch(false);
      }
    }
    onClose();
  }, [activeBatchId, batchFinalized, finalizingBatch, onClose, tryFinalizeBatch]);

  // Derived state
  const pendingSlots = slots.filter((s) => s.status === 'pending');
  const invalidSlots = slots.filter((s) => s.status === 'invalid');
  const failedSlots = slots.filter((s) => s.status === 'rejected' || s.status === 'error');
  const hasValidPending = pendingSlots.length > 0;
  const hasFailedSlots = failedSlots.length > 0;
  const isUploading = uploadPhase === 'uploading';
  const isDone = uploadPhase === 'done';

  const totalBatchBytes = slots.reduce((acc, s) => acc + s.file.size, 0);

  const canUpload =
    hasValidPending &&
    !isUploading &&
    !isDone &&
    invalidSlots.length === 0 &&
    pendingSlots.length <= UPLOAD_MAX_FILES &&
    totalBatchBytes <= UPLOAD_MAX_BATCH_BYTES;

  const maxMbLabel = `${UPLOAD_MAX_FILE_BYTES / (1024 * 1024)} MB`;

  return (
    <Dialog
      open={open}
      onClose={() => {
        void handleClose();
      }}
      title="Upload resumes"
      description={`Add up to ${UPLOAD_MAX_FILES} ${UPLOAD_ACCEPTED_TYPES_LABEL} files (max ${maxMbLabel} each) for processing.`}
      size="lg"
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              void handleClose();
            }}
            disabled={isUploading || finalizingBatch}
          >
            {isDone ? 'Close' : 'Cancel'}
          </Button>
          {isDone && hasFailedSlots ? (
            <Button variant="secondary" onClick={handleRetryFailed} disabled={finalizingBatch}>
              Retry failed ({failedSlots.length})
            </Button>
          ) : null}
          {isDone && closeFinalizeFailed && activeBatchId && !batchFinalized ? (
            <Button
              variant="ghost"
              onClick={() => {
                setCloseFinalizeFailed(false);
                onClose();
              }}
              disabled={finalizingBatch}
            >
              Close without finalizing
            </Button>
          ) : null}
          {isDone &&
          activeBatchId &&
          !batchFinalized &&
          (!hasFailedSlots || closeFinalizeFailed) ? (
            <Button
              variant="primary"
              onClick={() => {
                void handleFinalizeOpenBatch();
              }}
              loading={finalizingBatch}
              disabled={finalizingBatch}
            >
              Finalize batch
            </Button>
          ) : null}
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
        {/* Progress Bar during in-flight upload */}
        {isUploading && uploadProgress ? (
          <div
            className="space-y-1.5 rounded-lg border border-border bg-surface-muted/40 p-3"
            role="progressbar"
            aria-valuenow={uploadProgress.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="flex justify-between text-xs font-medium text-fg">
              <span>
                Uploading {uploadProgress.uploadedCount} of {uploadProgress.totalCount} files…
              </span>
              <span>{uploadProgress.percent}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${uploadProgress.percent}%` }}
              />
            </div>
          </div>
        ) : null}
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
              {batchFinalized && activeBatchId ? (
                <li className="font-medium text-success">Batch finalized for processing.</li>
              ) : activeBatchId && !batchFinalized ? (
                <li className="font-medium text-warning">
                  {hasFailedSlots
                    ? 'Partial batch open — retry remaining failed files or finalize to close the batch.'
                    : 'Batch open and pending finalization — retry "Finalize batch" to queue processing.'}
                </li>
              ) : null}
            </ul>
          </div>
        ) : isDone && batchFinalized && activeBatchId ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-4 py-3 text-xs font-medium text-success"
          >
            <Icon icon={CheckCircle2} size="sm" className="shrink-0" />
            <span>Batch finalized for processing.</span>
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
