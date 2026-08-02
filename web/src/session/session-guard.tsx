'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorState } from '@/components/composites/states';
import { dataErrorFor } from '@/data/errors';
import { useSession } from './use-session';

/**
 * T019 [027] — the route guard, over FOUR states.
 *
 * ── It is a courtesy, not enforcement ───────────────────────────────────────────────────────────
 * Every protected answer is refused by the gateway independently (Principle II). This redirects for
 * the person's benefit; deleting it would leak no data, only patience.
 *
 * ── The state table, and why two of the four hold ───────────────────────────────────────────────
 *
 *   `authenticated` → render the protected content.
 *   `anonymous`     → the server ANSWERED, and the answer is "no session". Redirect.
 *   `resolving`     → the question is out; no answer yet. Render neither, so nothing flashes.
 *   `unreachable`   → ⭐ the question **could not be asked**. Hold, say so, retry — never redirect.
 *
 * The last row is the whole reason this file changed. Reading "could not ask" as "signed out" turns
 * one network blip into every agent in the building being thrown back to a sign-in screen in the
 * middle of a ticket; the retry lives in the provider and this only reflects it.
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { state, refresh } = useSession();

  useEffect(() => {
    if (state.kind === 'anonymous') router.replace('/login');
  }, [state.kind, router]);

  if (state.kind === 'authenticated') return <>{children}</>;

  if (state.kind === 'unreachable') {
    // The message comes from the data layer's fixed taxonomy rather than being written here: it is
    // sanitized by construction, and it is retryable, which is what puts the Retry control on screen.
    return <ErrorState error={dataErrorFor('unavailable')} onRetry={() => void refresh()} />;
  }

  // `resolving` and `anonymous`: render nothing. The redirect above is already in flight for the
  // second one, and painting protected chrome first is precisely what SC-006 forbids.
  return null;
}
