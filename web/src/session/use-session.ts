'use client';

import { useCallback, useEffect, useState } from 'react';
import { MockSession } from './mock-session';
import type { Session } from './session';

// Module-level instance = the single swap point (mirrors getDataAccess()). Real Auth later
// replaces this binding behind the Session interface.
let current: Session = new MockSession();
export function getSession(): Session {
  return current;
}
export function setSession(impl: Session): void {
  current = impl;
}

/**
 * Reactive session hook for screens + the route guard. `ready` stays false until the client
 * has read storage on mount, so the guard never flashes protected content during hydration.
 */
export function useSession() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setAuthed(current.isAuthenticated());
    setReady(true);
  }, []);

  const login = useCallback(() => {
    current.login();
    setAuthed(true);
  }, []);

  const logout = useCallback(() => {
    current.logout();
    setAuthed(false);
  }, []);

  return { authed, ready, login, logout };
}
