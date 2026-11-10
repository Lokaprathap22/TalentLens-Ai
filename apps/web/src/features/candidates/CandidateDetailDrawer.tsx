import { ExternalLink, X } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';

import { IconButton } from '../../components/ui/icon-button.js';
import { CandidateDetailView } from './CandidateDetailView.js';

export interface CandidateDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  requisitionId: string;
  candidateId: string | null;
}

export function CandidateDetailDrawer({
  open,
  onClose,
  requisitionId,
  candidateId,
}: CandidateDetailDrawerProps): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = '';
      };
    }
  }, [open]);

  if (!open || !candidateId) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Candidate detail and resume inspection drawer"
      className="fixed inset-0 z-50 overflow-hidden"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over container */}
      <div className="fixed inset-y-0 right-0 flex max-w-full pl-4 sm:pl-8 lg:pl-12">
        <div className="flex w-screen max-w-5xl min-w-0 flex-col border-l border-border bg-bg shadow-2xl overflow-y-auto animate-in slide-in-from-right duration-200">
          {/* Top drawer control bar */}
          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg/95 px-4 py-3 backdrop-blur-xs sm:px-6">
            <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Candidate Workspace &middot; Resume Inspection
            </span>
            <div className="flex items-center gap-2">
              <Link
                to={`/requisitions/${encodeURIComponent(requisitionId)}/candidates/${encodeURIComponent(candidateId)}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-fg hover:bg-bg-subtle focus:outline-none focus:ring-1 focus:ring-accent"
                title="Open dedicated inspection page"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>Open dedicated page</span>
              </Link>
              <IconButton
                icon={X}
                label="Close candidate inspection drawer"
                onClick={onClose}
                size="sm"
              />
            </div>
          </div>

          {/* Drawer content */}
          <div className="flex-1 min-w-0">
            <CandidateDetailView
              requisitionId={requisitionId}
              candidateId={candidateId}
              onClose={onClose}
              variant="drawer"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
