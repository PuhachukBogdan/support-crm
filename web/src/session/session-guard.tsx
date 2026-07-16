'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from './use-session';

/**
 * Client-side route guard for dashboard routes. Redirects to /login when there is no mock
 * session, and renders nothing until the client has resolved the session (no protected-content
 * flash). DEMO CONVENIENCE, not enforcement — real authorization is server-side with Auth
 * (Principle II / roadmap 8.6).
 */
export function SessionGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { authed, ready } = useSession();

  useEffect(() => {
    if (ready && !authed) router.replace('/login');
  }, [ready, authed, router]);

  if (!ready || !authed) return null;
  return <>{children}</>;
}
