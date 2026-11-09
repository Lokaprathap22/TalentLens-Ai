import { useEffect, useState } from 'react';

const STORAGE_KEY = 'talentlens.sidebar.collapsed';

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Persisted desktop sidebar collapse preference. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(read);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      // Storage may be unavailable (private mode); the preference simply won't persist.
    }
  }, [collapsed]);

  return [collapsed, () => setCollapsed((value) => !value)];
}
