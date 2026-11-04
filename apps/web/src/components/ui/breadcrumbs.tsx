import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router';

import { Icon } from './icon.js';

export interface BreadcrumbItem {
  label: string;
  /** Omit for the current page. */
  to?: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }): React.JSX.Element {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-fg-subtle">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-1">
              {item.to && !last ? (
                <Link to={item.to} className="rounded-xs hover:text-fg hover:underline">
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'text-fg-muted' : ''}
                >
                  {item.label}
                </span>
              )}
              {!last ? (
                <Icon icon={ChevronRight} size="sm" className="shrink-0 text-fg-disabled" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
