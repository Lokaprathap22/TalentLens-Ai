import type { ReactNode } from 'react';

import { Breadcrumbs } from '../components/ui/index.js';
import type { BreadcrumbItem } from '../components/ui/index.js';
import { usePageTitle } from '../lib/use-page-title.js';

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  /** Contextual actions for this page. */
  actions?: ReactNode;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: PageHeaderProps): React.JSX.Element {
  usePageTitle(title);

  return (
    <div className="mb-6 flex flex-col gap-3.5 xl:flex-row xl:items-end xl:justify-between">
      <div className="min-w-0">
        {breadcrumbs ? (
          <div className="mb-2">
            <Breadcrumbs items={breadcrumbs} />
          </div>
        ) : null}
        <h1 className="text-3xl font-semibold text-fg">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-base text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
