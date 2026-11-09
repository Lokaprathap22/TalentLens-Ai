import { useEffect, useRef } from 'react';

import { Sidebar } from './Sidebar.js';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

/** Slide-over navigation for screens below the `lg` breakpoint, built on native <dialog>. */
export function MobileNav({ open, onClose }: MobileNavProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Close the drawer if the viewport grows into the desktop layout.
  useEffect(() => {
    if (!open) return;
    const query = window.matchMedia('(min-width: 64rem)');
    const onChange = (event: MediaQueryListEvent): void => {
      if (event.matches) onClose();
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [open, onClose]);

  return (
    <dialog
      ref={ref}
      aria-label="Navigation"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className="m-0 h-dvh max-h-none w-72 max-w-[85vw] animate-drawer-in overflow-hidden border-0 bg-sidebar p-0 shadow-lg backdrop:bg-overlay"
    >
      {open ? <Sidebar onNavigate={onClose} onClose={onClose} /> : null}
    </dialog>
  );
}
