'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';

/**
 * The account's own status catalogue (`GET /conversations/statuses`, feature 032) — fetched once per
 * screen mount and joined client-side, exactly as 032 designed it: the list rows carry the KEY, the
 * catalogue carries the words a person reads.
 *
 * Two consumers on this screen (W6):
 *   · the toolbar's Status filter derives its OPTIONS from it, narrowed to the current bucket's
 *     categories — so the screen can never offer a word the server would refuse (the `resolved`
 *     lesson), and a key-vs-category contradiction is unbuildable by UI;
 *   · the Status COLUMN renders `agentName` instead of the raw key — `vip_pending` is a spelling,
 *     "VIP Pending" is a label.
 *
 * ⚠️ Failure is an absence: with no catalogue the filter offers nothing new and the column falls back
 * to the key — degraded, readable, and never wrong.
 */

export interface StatusDef {
  key: string;
  /** `CONVERSATION_STATUS_CATEGORY_*` from the wire, normalised to the bare word here. */
  category: string;
  agentName: string;
  active: boolean;
}

interface StatusWire {
  key?: string;
  category?: string;
  agentName?: string;
  active?: boolean;
}

const CATEGORY_PREFIX = 'CONVERSATION_STATUS_CATEGORY_';

export function useStatuses(): { statuses: readonly StatusDef[] } {
  const dataAccess = useDataAccess();
  const [statuses, setStatuses] = useState<readonly StatusDef[]>([]);

  useEffect(() => {
    let alive = true;
    dataAccess
      .list<StatusWire>('conversation-statuses', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setStatuses(
          page.items
            .filter((s): s is Required<StatusWire> => typeof s?.key === 'string' && s.key !== '')
            .map((s) => ({
              key: s.key,
              category: String(s.category ?? '')
                .replace(CATEGORY_PREFIX, '')
                .toLowerCase(),
              agentName: s.agentName || s.key,
              active: s.active !== false,
            })),
        );
      })
      .catch(() => {
        // Contained: see the header.
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return { statuses };
}
