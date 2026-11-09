import type { LucideIcon } from 'lucide-react';
import { AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.js';
import { Button } from './button.js';
import { Icon } from './icon.js';

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-sunken', className)}
    />
  );
}

/** Wraps skeletons so assistive technology announces one loading message. */
export function LoadingRegion({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

interface StateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: StateProps & { icon: LucideIcon }): React.JSX.Element {
  return (
    <div className={cn('flex flex-col items-center px-6 py-10 text-center', className)}>
      <span className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-surface-muted text-fg-subtle">
        <Icon icon={icon} size="lg" />
      </span>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-fg-subtle">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
  className,
}: StateProps & { onRetry?: () => void }): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center px-6 py-10 text-center', className)}
    >
      <span className="mb-3 flex size-10 items-center justify-center rounded-lg border border-danger-border bg-danger-soft text-danger">
        <Icon icon={AlertTriangle} size="lg" />
      </span>
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-sm text-fg-subtle">{description}</p> : null}
      {onRetry ? (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
