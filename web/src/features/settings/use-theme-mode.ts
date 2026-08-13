'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { DataError } from '@/data/types';

interface UiPreferencesWire {
  values?: Record<string, string>;
}

/**
 * W18 (subpoint 5.3) — the theme, persisted WHERE THE PERSON IS, not where the browser is.
 *
 * ── Two stores, one order ────────────────────────────────────────────────────────────────────────
 * next-themes (localStorage + the preload script) stays the RENDER mechanism — it is what makes the
 * theme survive a reload without a flash, before any request could answer. The SERVER
 * (`/me/ui-preferences`, feature 021) is the source of truth ACROSS machines: on mount the stored
 * value is applied over the local one, and every change writes through. A failed write keeps the
 * local flip (the person asked for dark and gets dark NOW) and reports the error — a theme that
 * silently resets on the next machine is a small lie, a toggle that refuses to toggle is a broken
 * switch.
 *
 * ⚠️ The server sync runs ONCE per mount tree (a ref, not an effect-per-consumer): the topbar
 * toggle and the settings page share this hook, and two mounts must not race two GETs into two
 * `setTheme` calls.
 */
const synced = { current: false };

export function useThemeMode() {
  const dataAccess = useDataAccess();
  const { resolvedTheme, setTheme } = useTheme();
  const [error, setError] = useState<DataError | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    void dataAccess
      .get<UiPreferencesWire>('ui-preferences', '')
      .then((res) => {
        const mode = res?.values?.theme_mode;
        if (mode === 'light' || mode === 'dark') setTheme(mode);
      })
      .catch(() => {
        // Degrades to the local theme — readable, and never wrong about what the person sees.
      });
  }, [dataAccess, setTheme]);

  const setMode = useCallback(
    async (mode: 'light' | 'dark') => {
      setTheme(mode); // instant: the person asked for dark and gets dark NOW
      if (busy.current) return;
      busy.current = true;
      setError(null);
      try {
        await dataAccess.update('ui-preferences', '', { values: { theme_mode: mode } });
      } catch (e) {
        setError(toDataError(e));
      } finally {
        busy.current = false;
      }
    },
    [dataAccess, setTheme],
  );

  return { resolvedTheme, setMode, error };
}

/** Test seam: reset the once-per-tree sync guard. */
export function resetThemeSyncForTests(): void {
  synced.current = false;
}
