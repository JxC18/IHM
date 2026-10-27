// Préférences d'interface : localStorage du navigateur (PRD F8). Perte
// acceptable, jamais synchronisées, jamais utilisées pour déduire l'identité.
import { useCallback, useEffect, useState } from 'react';

const PREFIX = 'rm.pref.';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : on continue sans */
  }
}

export function usePref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (v: T) => {
      setValue(v);
      writePref(key, v);
    },
    [key],
  );
  return [value, set];
}

export type ThemePref = 'system' | 'light' | 'dark';

export function useTheme(): [ThemePref, (t: ThemePref) => void] {
  const [theme, setTheme] = usePref<ThemePref>('theme', 'system');
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return [theme, setTheme];
}
