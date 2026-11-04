import type { LucideIcon } from 'lucide-react';

const sizes = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24 } as const;

export type IconSize = keyof typeof sizes;

interface IconProps {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
}

/** Decorative icon with the project-wide size scale and stroke weight. */
export function Icon({ icon: Glyph, size = 'md', className }: IconProps): React.JSX.Element {
  return (
    <Glyph
      size={sizes[size]}
      strokeWidth={1.75}
      aria-hidden="true"
      focusable="false"
      className={className ?? 'shrink-0'}
    />
  );
}
