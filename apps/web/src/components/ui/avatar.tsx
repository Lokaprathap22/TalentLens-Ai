import type { LucideIcon } from 'lucide-react';

import { cn } from '../../lib/cn.js';
import { Icon } from './icon.js';

type AvatarSize = 'sm' | 'md' | 'lg';

const sizes: Record<AvatarSize, string> = {
  sm: 'size-6 text-2xs',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
};

/** Deterministic tonal palette so the same person always gets the same avatar. */
const tones = [
  'bg-ramp-1 text-ramp-6',
  'bg-info-soft text-info',
  'bg-warning-soft text-warning',
  'bg-surface-sunken text-fg-muted',
  'bg-success-soft text-success',
  'bg-danger-soft text-danger',
] as const;

function hash(value: string): number {
  let result = 0;
  for (const char of value) {
    result = (result * 31 + char.codePointAt(0)!) >>> 0;
  }
  return result;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]!;
  const last = parts.length > 1 ? parts[parts.length - 1]! : '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

interface AvatarProps {
  name: string;
  size?: AvatarSize;
  /** Use an icon instead of initials, e.g. for masked or anonymous subjects. */
  icon?: LucideIcon;
  className?: string;
}

export function Avatar({ name, size = 'md', icon, className }: AvatarProps): React.JSX.Element {
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold',
        sizes[size],
        tones[hash(name) % tones.length],
        className,
      )}
    >
      {icon ? <Icon icon={icon} size={size === 'lg' ? 'md' : 'sm'} /> : initials(name)}
    </span>
  );
}
