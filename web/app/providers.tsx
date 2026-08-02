'use client';

import { useRef, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'next-themes';
import { makeStore, type AppStore } from '../src/store';
import { DataAccessProvider } from '@/data/provider';
import { SessionProvider } from '@/session';
import type { SessionState } from '@/session';

// Client providers: theme (next-themes toggles the `.dark` token set) + per-request Redux store
// + the data-access binding (mock now, real gateway later) so useRecords resolves app-wide
// + the session, resolved once per navigation and shared (feature 027).
export function Providers({
  children,
  sessionSeed,
}: {
  children: ReactNode;
  /** Server-read hint, so the first paint is never the wrong answer (SC-006). */
  sessionSeed?: SessionState;
}) {
  const storeRef = useRef<AppStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = makeStore();
  }
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Provider store={storeRef.current}>
        <DataAccessProvider>
          <SessionProvider seed={sessionSeed}>{children}</SessionProvider>
        </DataAccessProvider>
      </Provider>
    </ThemeProvider>
  );
}
