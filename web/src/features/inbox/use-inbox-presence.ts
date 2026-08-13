'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { useSession } from '@/session';

interface UnseenWire {
  count?: number;
  openedAt?: string;
}

/**
 * ⭐ W25 (R23 / 9.12) — the Inbox PAGE's half of the counter contract: "I am looking at the list."
 *
 * On mount: read the mark FIRST (the pre-visit `openedAt` is what lets the list dot the rows that
 * arrived while the person was away), THEN reset it. While mounted: every realtime arrival re-marks,
 * which is rule 2 made literal — «Inbox открыт + пришёл тикет → не растёт, потому что он сразу
 * просмотрен». The order matters and is deliberate: dots are computed against the mark as it stood
 * BEFORE this visit, so resetting does not erase what the person is owed a look at.
 *
 * ⚠️ The re-mark subscription is separate from `useLiveRefresh` on purpose: that hook's job is the
 * LIST's freshness and it holds off below page one; this one must fire on every arrival regardless,
 * or a ticket landing while you read page two would count as unseen the moment you leave.
 */
export function useInboxPresence(): { unseenSince: string | null } {
  const dataAccess = useDataAccess();
  const { state } = useSession();
  const authenticated = state.kind === 'authenticated';
  const [unseenSince, setUnseenSince] = useState<string | null>(null);

  useEffect(() => {
    if (!authenticated) return;
    let alive = true;
    const markOpened = () =>
      dataAccess.update<UnseenWire>('inbox-opened', '', {}).catch(() => {
        // A failed reset means the badge stays until the next successful one — visible and honest,
        // never an error banner in the chrome.
      });

    void dataAccess
      .get<UnseenWire>('inbox-unseen', '')
      .then((res) => {
        if (alive) setUnseenSince(res?.openedAt || null);
      })
      .catch(() => {
        // No dots, badge untouched — degradation, not failure.
      })
      .finally(() => {
        void markOpened();
      });

    const unsubscribe = dataAccess.subscribe((event) => {
      if (event.kind === 'conversation.created' || event.kind === 'reconnected') {
        void markOpened();
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [authenticated, dataAccess]);

  return { unseenSince };
}
