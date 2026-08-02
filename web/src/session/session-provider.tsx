'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SessionContext, type SessionContextValue } from './session-context';
import { getSession } from './use-session';
import type { Session, SessionState } from './session';

/**
 * T017/T018 [027] — resolves the session ONCE per navigation and shares the answer.
 *
 * ── What the seed does, and what it deliberately does not do ────────────────────────────────────
 * `seed` comes from the server, which can see the httpOnly cookie the browser cannot. It is a
 * **hint**, never an answer (`session-seed.ts`):
 *
 *   `anonymous`  — no cookie existed. Authoritative, and the sign-in page paints with no request
 *                  at all and nothing to correct a moment later.
 *   `resolving`  — a cookie existed. We hold and ask the gateway, which is the only authority.
 *
 * So there is no first paint of the wrong answer (SC-006), and no authentication decision is made
 * in the browser (Principle II).
 *
 * ⚠️ **`unreachable` retries; it never decays into `anonymous`.** A person whose network blinked is
 * not a person who signed out, and the difference is a whole floor of agents losing their place
 * mid-ticket.
 */

/** How long to wait before asking again while the service cannot be reached. */
export const RETRY_DELAY_MS = 5_000;

export function SessionProvider({
  seed,
  impl,
  children,
}: {
  seed?: SessionState;
  /** Override for tests and for the swap point; defaults to the module binding. */
  impl?: Session;
  children: ReactNode;
}) {
  const session = useMemo(() => impl ?? getSession(), [impl]);
  const [state, setState] = useState<SessionState>(() => seed ?? session.state());

  // A resolution in flight is shared rather than started twice: React 18/19 mounts effects twice in
  // development, and two mounts asking the gateway two questions is the per-component shape this
  // provider exists to replace.
  const inflight = useRef<Promise<SessionState> | null>(null);

  const refresh = useCallback(async (): Promise<SessionState> => {
    if (!inflight.current) {
      inflight.current = session.resolve().finally(() => {
        inflight.current = null;
      });
    }
    const next = await inflight.current;
    setState(next);
    return next;
  }, [session]);

  // Ask once, when the seed says there might be something to ask about.
  useEffect(() => {
    if (state.kind === 'resolving') void refresh();
  }, [state.kind, refresh]);

  // …and keep asking, on a timer, for as long as the question cannot be asked.
  useEffect(() => {
    if (state.kind !== 'unreachable') return;
    const timer = setTimeout(() => void refresh(), RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [state, refresh]);

  const value: SessionContextValue = useMemo(
    () => ({ state, session, refresh }),
    [state, session, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
