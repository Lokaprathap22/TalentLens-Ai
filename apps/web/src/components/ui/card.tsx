import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.js';

interface CardProps {
  children: ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
  /** Accessible name for a section card, usually the id of its heading. */
  labelledBy?: string;
}

export function Card({
  children,
  className,
  as: Tag = 'section',
  labelledBy,
}: CardProps): React.JSX.Element {
  return (
    <Tag
      aria-labelledby={labelledBy}
      className={cn('rounded-lg border border-border bg-surface shadow-xs', className)}
    >
      {children}
    </Tag>
  );
}

interface CardHeaderProps {
  title: string;
  titleId?: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({
  title,
  titleId,
  description,
  actions,
  className,
}: CardHeaderProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 px-5 pt-4 pb-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 id={titleId} className="text-lg font-semibold text-fg">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-fg-subtle">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={cn('px-5 pb-5', className)}>{children}</div>;
}

export function CardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('border-t border-border px-5 py-3 text-sm text-fg-subtle', className)}>
      {children}
    </div>
  );
}
