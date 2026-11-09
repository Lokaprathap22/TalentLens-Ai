import { ArrowRight, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { allNavItems, UNAVAILABLE_REASON } from '../app/navigation.js';
import { Dialog, EmptyState, Icon, SearchField } from '../components/ui/index.js';
import { cn } from '../lib/cn.js';

interface SearchDialogProps {
  open: boolean;
  onClose: () => void;
}

function SearchPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Wait for the native dialog to open before moving focus into it.
    const frame = requestAnimationFrame(() => wrapper.current?.querySelector('input')?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allNavItems().filter((item) => item.label.toLowerCase().includes(needle));
  }, [query]);

  const firstAvailable = results.find((item) => item.available);

  return (
    <div ref={wrapper}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (firstAvailable) {
            void navigate(firstAvailable.to);
            onClose();
          }
        }}
      >
        <SearchField
          label="Search pages"
          placeholder="Search pages…"
          value={query}
          onValueChange={setQuery}
        />
      </form>

      <p className="mt-4 mb-1.5 text-2xs font-semibold tracking-wider text-fg-subtle uppercase">
        Pages
      </p>
      {results.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="No matching pages"
          description="Candidate, requisition and client search will arrive with the API integration."
        />
      ) : (
        <ul className="-mx-2" aria-live="polite">
          {results.map((item) => (
            <li key={item.id}>
              {item.available ? (
                <Link
                  to={item.to}
                  onClick={onClose}
                  className="flex h-9 items-center gap-3 rounded-md px-2 text-sm text-fg hover:bg-surface-muted"
                >
                  <Icon icon={item.icon} size="md" className="shrink-0 text-fg-subtle" />
                  <span className="flex-1">{item.label}</span>
                  <Icon icon={ArrowRight} size="sm" className="text-fg-disabled" />
                </Link>
              ) : (
                <div
                  aria-disabled="true"
                  title={UNAVAILABLE_REASON}
                  className={cn(
                    'flex h-9 items-center gap-3 rounded-md px-2 text-sm text-fg-disabled',
                  )}
                >
                  <Icon icon={item.icon} size="md" className="shrink-0" />
                  <span className="flex-1">{item.label}</span>
                  <span className="text-2xs">Not available yet</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SearchDialog({ open, onClose }: SearchDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Search"
      description="Jump to a page. Press Enter to open the first match."
    >
      {open ? <SearchPanel onClose={onClose} /> : null}
    </Dialog>
  );
}
