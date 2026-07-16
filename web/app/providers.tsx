'use client';

import { useRef, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'next-themes';
import { makeStore, type AppStore } from '../src/store';

// Client providers: theme (next-themes toggles the `.dark` token set) + per-request Redux store.
export function Providers({ children }: { children: ReactNode }) {
  const storeRef = useRef<AppStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = makeStore();
  }
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Provider store={storeRef.current}>{children}</Provider>
    </ThemeProvider>
  );
}
