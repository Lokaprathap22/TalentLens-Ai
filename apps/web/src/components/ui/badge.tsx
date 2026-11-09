import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const tones: Record<BadgeTone, { box: string; dot: string }> = {
  neutral: { box: 'border-border bg-surface-muted text-fg-muted', dot: 'bg-fg-disabled' },
  accent: { box: 'border-accent-border bg-accent-soft text-accent-fg', dot: 'bg-accent' },
  success: { box: 'border-success-border bg-success-soft text-success', dot: 'bg-success-solid' },
  warning: { box: 'border-warning-border bg-warning-soft text-warning', dot: 'bg-warning-solid' },
  danger: { box: 'border-danger-border bg-danger-soft text-danger', dot: 'bg-danger-solid' },
  info: { box: 'border-info-border bg-info-soft text-info', dot: 'bg-info-solid' },
};

interface BadgeProps {
  tone?: BadgeTone;
  /** Show a leading status dot. Colour is never the only signal: always include text. */
  dot?: boolean;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}

export function Badge({
  tone = 'neutral',
  dot = false,
  icon,
  children,
  className,
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium',
        tones[tone].box,
        className,
      )}
    >
      {dot ? (
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', tones[tone].dot)} />
      ) : null}
      {icon ? <Icon icon={icon} size="xs" /> : null}
      {children}
    </span>
  );
}
