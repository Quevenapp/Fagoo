import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'brufap.erp.theme';
const EVENT = 'brufap-theme';

export function readTheme(): Theme {
  try { return globalThis.localStorage?.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

/** Applies the user's saved "Habilita tema escuro" (Preferências › Sistema › Interface) to this browser and to every mounted toggle. */
export function applyStoredTheme(theme: Theme) {
  try { globalThis.localStorage?.setItem(KEY, theme); } catch { /* Theme stays for this visit. */ }
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.dataset.theme = theme;
  try { globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: theme })); } catch { /* No window (tests). */ }
}

// Same preference as Origin's "Tema escuro" switch in the user menu, shared by demo and company areas.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
    try { globalThis.localStorage?.setItem(KEY, theme); } catch { /* Theme stays for this visit. */ }
  }, [theme]);
  useEffect(() => {
    const listener = (event: Event) => { const next = (event as CustomEvent).detail; if (next === 'dark' || next === 'light') setTheme(next); };
    globalThis.addEventListener?.(EVENT, listener);
    return () => globalThis.removeEventListener?.(EVENT, listener);
  }, []);
  return { theme, toggle: () => setTheme(current => current === 'dark' ? 'light' : 'dark') };
}
