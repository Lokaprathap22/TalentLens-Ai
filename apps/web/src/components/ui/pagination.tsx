import { ChevronLeft, ChevronRight } from 'lucide-react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Singular/plural noun for the summary, e.g. "candidates". */
  noun?: string;
}

/** Page numbers with ellipses: 1 … 4 5 6 … 12 */
export function pageWindow(page: number, pageCount: number): Array<number | 'gap'> {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const pages = new Set<number>([1, pageCount, page - 1, page, page + 1]);
  const sorted = [...pages]
    .filter((value) => value >= 1 && value <= pageCount)
    .sort((a, b) => a - b);
  const result: Array<number | 'gap'> = [];
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && value - previous > 1) result.push('gap');
    result.push(value);
  });
  return result;
}

const pageButton =
  'inline-flex size-8 items-center justify-center rounded-md text-sm font-medium tabular transition-colors';

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun = 'results',
}: PaginationProps): React.JSX.Element | null {
  if (total === 0) return null;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3"
    >
      <p className="tabular text-sm text-fg-subtle" aria-live="polite">
        Showing{' '}
        <span className="font-medium text-fg-muted">
          {first}–{last}
        </span>{' '}
        of <span className="font-medium text-fg-muted">{total}</span> {noun}
      </p>
      {pageCount > 1 ? (
        <ul className="flex items-center gap-1">
          <li>
            <button
              type="button"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className={cn(
                pageButton,
                'text-fg-muted hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              <Icon icon={ChevronLeft} size="md" />
            </button>
          </li>
          {pageWindow(page, pageCount).map((entry, index) =>
            entry === 'gap' ? (
              <li key={`gap-${index}`} aria-hidden="true" className="px-1 text-fg-disabled">
                …
              </li>
            ) : (
              <li key={entry} className="hidden sm:block">
                <button
                  type="button"
                  aria-label={`Page ${entry}`}
                  aria-current={entry === page ? 'page' : undefined}
                  onClick={() => onPageChange(entry)}
                  className={cn(
                    pageButton,
                    entry === page
                      ? 'bg-accent-soft text-accent-fg'
                      : 'text-fg-muted hover:bg-surface-muted',
                  )}
                >
                  {entry}
                </button>
              </li>
            ),
          )}
          <li className="px-2 text-sm text-fg-subtle tabular sm:hidden">
            {page} / {pageCount}
          </li>
          <li>
            <button
              type="button"
              aria-label="Next page"
              disabled={page >= pageCount}
              onClick={() => onPageChange(page + 1)}
              className={cn(
                pageButton,
                'text-fg-muted hover:bg-surface-muted disabled:opacity-40 disabled:hover:bg-transparent',
              )}
            >
              <Icon icon={ChevronRight} size="md" />
            </button>
          </li>
        </ul>
      ) : null}
    </nav>
  );
}
