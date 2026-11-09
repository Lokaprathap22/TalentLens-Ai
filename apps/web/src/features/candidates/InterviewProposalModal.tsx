import { Calendar, Clock, Globe, Video, Phone, MapPin, AlertCircle } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';

import { Dialog } from '../../components/ui/dialog.js';
import { Button } from '../../components/ui/button.js';

export interface InterviewProposalModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: {
    startAt: string;
    endAt?: string | undefined;
    timezone: string;
    format: 'VIDEO' | 'PHONE' | 'IN_PERSON';
    reason?: string | undefined;
    proposalId?: string | undefined;
  }) => Promise<void>;
  isLoading: boolean;
  error: string | null;
  rescheduleProposalId?: string | null;
  candidateCode: string;
}

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];

export function InterviewProposalModal({
  open,
  onClose,
  onSubmit,
  isLoading,
  error,
  rescheduleProposalId,
  candidateCode,
}: InterviewProposalModalProps): React.JSX.Element {
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  // Default start date: tomorrow at 10:00 AM local time
  const getDefaultDateTime = (): string => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    // Format YYYY-MM-DDTHH:mm
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  };

  const [datetimeLocal, setDatetimeLocal] = useState<string>(getDefaultDateTime);
  const [durationMinutes, setDurationMinutes] = useState<number>(45);
  const [timezone, setTimezone] = useState<string>(localTz);
  const [format, setFormat] = useState<'VIDEO' | 'PHONE' | 'IN_PERSON'>('VIDEO');
  const [reason, setReason] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleClose = (): void => {
    setDatetimeLocal(getDefaultDateTime());
    setDurationMinutes(45);
    setTimezone(localTz);
    setFormat('VIDEO');
    setReason('');
    setValidationError(null);
    onClose();
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setValidationError(null);

    if (!datetimeLocal) {
      setValidationError('Please select a date and time for the interview.');
      return;
    }

    const startDate = new Date(datetimeLocal);
    if (isNaN(startDate.getTime())) {
      setValidationError('Invalid date and time selected.');
      return;
    }

    const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

    try {
      await onSubmit({
        startAt: startDate.toISOString(),
        endAt: endDate.toISOString(),
        timezone,
        format,
        reason: reason.trim() || undefined,
        proposalId: rescheduleProposalId ?? undefined,
      });
      handleClose();
    } catch {
      // Error handled via props
    }
  };

  const timezonesList = COMMON_TIMEZONES.includes(timezone)
    ? COMMON_TIMEZONES
    : [timezone, ...COMMON_TIMEZONES];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={rescheduleProposalId ? 'Propose Alternative Interview Window' : 'Schedule Interview'}
      description={`Coordinate an interview proposal for candidate ${candidateCode}.`}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-4 pt-1">
        {/* Date & Time */}
        <div className="space-y-1.5">
          <label
            htmlFor="interview-datetime"
            className="text-xs font-medium text-fg flex items-center gap-1.5"
          >
            <Calendar className="h-3.5 w-3.5 text-accent" />
            Interview Date & Start Time
          </label>
          <input
            id="interview-datetime"
            type="datetime-local"
            value={datetimeLocal}
            onChange={(e) => {
              setDatetimeLocal(e.target.value);
              if (validationError) setValidationError(null);
            }}
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Duration & Timezone grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label
              htmlFor="interview-duration"
              className="text-xs font-medium text-fg flex items-center gap-1.5"
            >
              <Clock className="h-3.5 w-3.5 text-accent" />
              Duration
            </label>
            <select
              id="interview-duration"
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value={30}>30 minutes</option>
              <option value={45}>45 minutes</option>
              <option value={60}>60 minutes</option>
              <option value={90}>90 minutes</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="interview-tz"
              className="text-xs font-medium text-fg flex items-center gap-1.5"
            >
              <Globe className="h-3.5 w-3.5 text-accent" />
              Timezone
            </label>
            <select
              id="interview-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-fg focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {timezonesList.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Format */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-fg block">Interview Format</label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setFormat('VIDEO')}
              className={`flex items-center justify-center gap-1.5 rounded-md border p-2 text-xs font-medium transition-all ${
                format === 'VIDEO'
                  ? 'border-accent bg-accent/15 text-accent font-semibold ring-1 ring-accent'
                  : 'border-border bg-surface text-fg-subtle hover:text-fg hover:bg-surface-muted'
              }`}
            >
              <Video className="h-3.5 w-3.5" />
              Video Call
            </button>
            <button
              type="button"
              onClick={() => setFormat('PHONE')}
              className={`flex items-center justify-center gap-1.5 rounded-md border p-2 text-xs font-medium transition-all ${
                format === 'PHONE'
                  ? 'border-accent bg-accent/15 text-accent font-semibold ring-1 ring-accent'
                  : 'border-border bg-surface text-fg-subtle hover:text-fg hover:bg-surface-muted'
              }`}
            >
              <Phone className="h-3.5 w-3.5" />
              Phone Call
            </button>
            <button
              type="button"
              onClick={() => setFormat('IN_PERSON')}
              className={`flex items-center justify-center gap-1.5 rounded-md border p-2 text-xs font-medium transition-all ${
                format === 'IN_PERSON'
                  ? 'border-accent bg-accent/15 text-accent font-semibold ring-1 ring-accent'
                  : 'border-border bg-surface text-fg-subtle hover:text-fg hover:bg-surface-muted'
              }`}
            >
              <MapPin className="h-3.5 w-3.5" />
              In Person
            </button>
          </div>
        </div>

        {/* Reason / Notes */}
        <div className="space-y-1.5">
          <label htmlFor="interview-reason" className="text-xs font-medium text-fg block">
            {rescheduleProposalId ? 'Reason for Rescheduling / Notes' : 'Proposal Notes (optional)'}
          </label>
          <textarea
            id="interview-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder={
              rescheduleProposalId
                ? 'Explain why an alternative window is proposed...'
                : 'Add agenda, meeting link placeholders, or notes for the client...'
            }
            className="w-full rounded-md border border-border bg-surface p-2.5 text-xs text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Validation error */}
        {validationError ? (
          <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{validationError}</span>
          </div>
        ) : null}

        {/* Server error */}
        {error ? (
          <div className="rounded border border-danger/30 bg-danger/5 p-2 text-xs text-danger flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={isLoading}>
            {isLoading
              ? 'Sending Proposal...'
              : rescheduleProposalId
                ? 'Submit Alternative Window'
                : 'Send Interview Proposal'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
