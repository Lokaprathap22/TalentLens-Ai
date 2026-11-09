import { useEffect } from 'react';

/** Keeps the browser tab title in sync with the current screen. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · TalentLens AI`;
  }, [title]);
}
