'use client';

import { createContext } from 'react';
import type { Session, SessionState } from './session';

/**
 * The context the provider fills and `useSession()` reads. It is its own module so that the hook,
 * the provider and the guard can share it without a cycle.
 */
export interface SessionContextValue {
  /** The current answer. Four values — see `session.ts`. */
  readonly state: SessionState;
  /** The boundary's verbs. Screens depend on this and on nothing else for authentication (FR-019). */
  readonly session: Session;
  /** Ask the gateway again. Used after a sign-in completes and when retrying from `unreachable`. */
  refresh(): Promise<SessionState>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);
