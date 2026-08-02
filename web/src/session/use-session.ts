'use client';

import { useContext } from 'react';
import { GatewaySession } from './gateway-session';
import { SessionContext, type SessionContextValue } from './session-context';
import type { Session } from './session';

/**
 * T018 [027] — the session binding and the hook screens read.
 *
 * ── One resolution per navigation, SHARED — and therefore no cache ──────────────────────────────
 * The resolution happens once in `SessionProvider` and every consumer reads the same context value
 * (Principle VII). That is deliberately not a cache with a TTL: there is no stored answer to go
 * stale, because there is only ever one answer per mounted provider. A per-component `useEffect`
 * would ask the gateway once per rendered component, which is the shape this replaces.
 */

// Module-level instance = the single swap point, mirroring `getDataAccess()` in `data/provider`.
// It is the real gateway session now: the mock is gone, and `no-mock-session.test.ts` keeps it gone.
let current: Session = new GatewaySession();

export function getSession(): Session {
  return current;
}
export function setSession(impl: Session): void {
  current = impl;
}

/**
 * The session as screens see it: the current state, the boundary's verbs, and a way to ask again.
 *
 * ⚠️ Throws outside a `SessionProvider` rather than inventing a default. A hook that quietly
 * answered `anonymous` when it had never asked anything would make a missing provider look exactly
 * like a signed-out person — and the bug would present as "sometimes it logs me out".
 */
export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession() requires a <SessionProvider> above it');
  return value;
}
