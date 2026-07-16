'use client';

import { useRef, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'next-themes';
import { makeStore, type AppStore } from '../src/store';
import { DataAccessProvider } from '@/data/provider';

// Client providers: theme (next-themes toggles the `.dark` token set) + per-request Redux store
// + the data-access binding (mock now, real gateway later) so useRecords resolves app-wide.
export function Providers({ children }: { children: ReactNode }) {
  const storeRef = useRef<AppStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = makeStore();
  }
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Provider store={storeRef.current}>
        <DataAccessProvider>{children}</DataAccessProvider>
      </Provider>
    </ThemeProvider>
  );
}
