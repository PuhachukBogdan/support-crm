'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';

/**
 * "Which operator am I?" — the client half of roadmap 5.11 (W6).
 *
 * One GET per mount of the screen that asks; the answer is immutable for a session (the mapping
 * auth-identity → operator id never changes), so there is no refresh, no polling and no cache
 * invalidation to get wrong.
 *
 * ⚠️ **The whole Inbox is scoped by this answer** (operator, 2026-08-06), so failure here is not a
 * degraded mode — it is "the screen cannot know whose tickets to show". The hook therefore reports a
 * STATUS, and the screen renders the identity's own loading/error instead of a list: an unscoped
 * list would be both the confidently-wrong answer (the 012 lesson) and a disclosure.
 */

interface MeOperator {
  operatorId?: string;
  displayName?: string;
  active?: boolean;
}

export interface MyOperator {
  operatorId: string | undefined;
  status: 'loading' | 'ready' | 'error';
  retry: () => void;
}

export function useMyOperator(): MyOperator {
  const dataAccess = useDataAccess();
  const [state, setState] = useState<{ operatorId?: string; status: MyOperator['status'] }>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setState((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    dataAccess
      .get<MeOperator>('me-operator', '')
      .then((me) => {
        if (!alive) return;
        if (typeof me?.operatorId === 'string' && me.operatorId !== '') {
          setState({ operatorId: me.operatorId, status: 'ready' });
        } else {
          // An answer with no id is a server defect, not a retryable blip — but the screen's
          // response is the same either way: it cannot scope, so it must not list.
          setState({ status: 'error' });
        }
      })
      .catch(() => {
        if (alive) setState({ status: 'error' });
      });
    return () => {
      alive = false;
    };
  }, [dataAccess, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { operatorId: state.operatorId, status: state.status, retry };
}
