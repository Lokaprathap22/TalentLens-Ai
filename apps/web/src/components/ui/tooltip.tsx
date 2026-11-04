import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { HTMLAttributes, ReactElement } from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'right';

interface TooltipProps {
  content: string;
  side?: Side;
  /** A single focusable element. The tooltip describes it for assistive technology. */
  children: ReactElement<HTMLAttributes<HTMLElement>>;
}

interface Position {
  top: number;
  left: number;
}

const GAP = 8;

function place(rect: DOMRect, side: Side): Position {
  if (side === 'right') return { top: rect.top + rect.height / 2, left: rect.right + GAP };
  if (side === 'bottom') return { top: rect.bottom + GAP, left: rect.left + rect.width / 2 };
  return { top: rect.top - GAP, left: rect.left + rect.width / 2 };
}

const transforms: Record<Side, string> = {
  top: 'translate(-50%, -100%)',
  bottom: 'translate(-50%, 0)',
  right: 'translate(0, -50%)',
};

export function Tooltip({ content, side = 'top', children }: TooltipProps): React.JSX.Element {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  const show = useCallback(() => {
    if (anchor.current) setPosition(place(anchor.current.getBoundingClientRect(), side));
  }, [side]);
  const hide = useCallback(() => setPosition(null), []);

  useEffect(() => {
    if (!position) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [position, hide]);

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {cloneElement(children, { 'aria-describedby': position ? id : undefined })}
      {position
        ? createPortal(
            <div
              id={id}
              role="tooltip"
              style={{ top: position.top, left: position.left, transform: transforms[side] }}
              className="pointer-events-none fixed z-[70] max-w-64 animate-fade-in rounded-md bg-fg px-2 py-1 text-xs font-medium text-surface shadow-md"
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
