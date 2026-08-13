'use client';

import { useRef, type ReactNode } from 'react';
import { Provider } from 'react-redux';
import { ThemeProvider } from 'next-themes';
import { makeStore, type AppStore } from '../src/store';
import { DataAccessProvider } from '@/data/provider';
import { GatewayDataAccess } from '@/data/gateway/gateway-data-access';
import { createWsPort } from '@/data/gateway/ws-port';
import type { DataAccess } from '@/data/data-access';
import { SessionProvider } from '@/session';
import { StaleBuildRecovery } from '@/components/shell/stale-build-recovery';
import type { SessionState } from '@/session';

// Client providers: theme (next-themes toggles the `.dark` token set) + per-request Redux store
// + the data-access binding (mock now, real gateway later) so useRecords resolves app-wide
// + the session, resolved once per navigation and shared (feature 027).
export function Providers({
  children,
  sessionSeed,
  dataAccess,
}: {
  children: ReactNode;
  /** Server-read hint, so the first paint is never the wrong answer (SC-006). */
  sessionSeed?: SessionState;
  /**
   * Override the transport. The application never passes one — it gets the gateway. Tests pass a
   * stub here rather than calling `setDataAccess` beforehand, because this component now binds on
   * render and would otherwise overwrite the injection.
   */
  dataAccess?: DataAccess;
}) {
  const storeRef = useRef<AppStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = makeStore();
  }

  /**
   * ⭐ **THE SWAP POINT, ACTUALLY USED.** Found live on 2026-08-02, after the Inbox shipped.
   *
   * `getDataAccess()` defaults to `MockDataAccess`, and **nothing in the application had ever
   * replaced it** — `GatewayDataAccess` was constructed only in tests. So every screen was reading
   * demo records: the Inbox asked the mock for conversations and got an error, and the whole feature
   * had been verified as two halves that never met — the API by live script, the screen by jsdom.
   *
   * ⚠️ That is exactly what ADR 0037 forbids: *"a page is not connected until it has run live against
   * the prepared test host — not only Jest."* Neither half was wrong; the wire between them did not
   * exist. `swap-point.test.ts` proved the swap MECHANISM works and nothing proved the app performs
   * it — the fourth time in this feature that a correct rule had no consumer exercising it.
   *
   * Created once per store, and `DataAccessProvider` publishes it to the saga accessor in an effect,
   * so the binding happens in the browser where a same-origin fetch means something.
   */
  const dataAccessRef = useRef<DataAccess | null>(null);
  if (dataAccessRef.current === null) {
    /**
     * ⭐ Feature 034 (W4): the socket is handed to the real implementation **here**, in the one file
     * allowed to name one — because the alternative is precisely the defect the comment above records.
     * A `ws-port.ts` that existed, was tested, and was never passed to anything would be
     * `wired-only-in-tests` a second time, in the same seam, four days later.
     *
     * ⓘ Reconnection needs no wiring here: the port delivers a `reconnected` event through the same
     * subscription, so the screen that owns a query is the thing that re-reads (FR-013). The composition
     * root deliberately knows nothing about queries — it chooses an implementation and nothing else.
     */
    dataAccessRef.current = dataAccess ?? new GatewayDataAccess(undefined, createWsPort());
  }
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <Provider store={storeRef.current}>
        <DataAccessProvider impl={dataAccessRef.current}>
          {/* Outside the session tree on purpose: a tab left open across a deployment must recover
              whether or not the session has resolved. */}
          <StaleBuildRecovery />
          <SessionProvider seed={sessionSeed}>{children}</SessionProvider>
        </DataAccessProvider>
      </Provider>
    </ThemeProvider>
  );
}
