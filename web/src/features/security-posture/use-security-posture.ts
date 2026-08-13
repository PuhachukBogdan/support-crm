'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState } from '@/data/types';
import type { SecurityPostureWire } from './types';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.11) — the one read behind the security-posture page.
 *
 * A SINGLETON `get`, and there is deliberately nothing else here: no write, no cache, no merge, no
 * local state that outlives the request. Every fact on the page is read at request time (FR-017), and
 * a hook that kept the previous answer around would be the beginning of a page that reports
 * yesterday's protections with today's confidence.
 *
 * ⚠️ **Refreshing re-asks the server**, which is the whole point of the button that calls it: the
 * page's promise is that changing the system and reloading changes the page (SC-006). A refresh that
 * re-rendered a cached answer would break that promise silently.
 *
 * ⓘ Zero facts is `empty`, and the screen renders it as «nothing could be read», never as a clean
 * bill of health — an absent sweep and an empty one are different answers (FR-016's shape, applied to
 * the read this page is made of).
 */
export function useSecurityPosture() {
  const dataAccess = useDataAccess();
  const [posture, setPosture] = useState<AsyncState<SecurityPostureWire>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setPosture({ status: 'loading' });
    void dataAccess
      // `''` — the singleton takes no id, and the transport refuses one (there is nobody else this
      // path could name: the posture is the caller's own account's).
      .get<SecurityPostureWire>('admin-security', '')
      .then((answer) => {
        if (!alive) return;
        const facts = answer?.facts ?? [];
        setPosture(
          facts.length === 0
            ? { status: 'empty' }
            : { status: 'ready', data: { facts, generatedAt: answer?.generatedAt ?? '' } },
        );
      })
      .catch((e) => alive && setPosture({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  return { posture, refresh };
}
