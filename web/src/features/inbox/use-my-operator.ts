'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';

/**
 * "Which operator am I?" — the client half of roadmap 5.11 (W6).
 *
 * One GET per mount of the screen that asks; the answer is immutable for a session (the mapping
 * auth-identity → operator id never changes), so there is no refresh, no polling and no cache
 * invalidation to get wrong.
 *
 * ⚠️ **Failure is an ABSENCE, and the consumer must treat it as one.** `operatorId` stays undefined
 * when the read fails — the «Мои» scope control is then DISABLED, never silently un-scoped: "my
 * tickets" quietly meaning "all tickets" is the confidently-wrong-answer shape this codebase keeps
 * refusing (the 012 lesson, restated in `use-inbox-query`).
 */

interface MeOperator {
  operatorId?: string;
  displayName?: string;
  active?: boolean;
}

export function useMyOperator(): { operatorId: string | undefined } {
  const dataAccess = useDataAccess();
  const [operatorId, setOperatorId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    dataAccess
      .get<MeOperator>('me-operator', '')
      .then((me) => {
        if (alive && typeof me?.operatorId === 'string' && me.operatorId !== '') {
          setOperatorId(me.operatorId);
        }
      })
      .catch(() => {
        // Contained: the screen works unscoped, exactly as it did before 5.11 existed.
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return { operatorId };
}
