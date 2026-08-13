'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { useMyOperator } from '@/features/inbox/use-my-operator';
import type { ConversationRow } from '@/features/inbox/types';

/**
 * W10 — the agent's own active tickets, for the tab above the right panel (R17, roadmap 4.19).
 *
 * ⭐ The rail is a VIEW over three facts and nothing is stored: **assigned to me** ∧ **I opened it**
 * (a `ConversationReadMark`, written by the gateway when the window reads the ticket) ∧ a
 * non-terminal category. So this composes `/conversations` with three filters — there is no
 * dedicated route, and adding one would be a second definition of the same view.
 *
 * ⚠️⚠️ **R17a's lifecycle is NOT what ships, and this hook does not pretend otherwise.** The
 * operator's rule (2026-08-04) is *enters at the first public reply · leaves at Pending · returns
 * when the customer replies*. What the server can answer today:
 *   · ENTERS when the agent OPENS the ticket — the read mark is the only "he started on it" fact
 *     that exists; `conversation.first_public_reply` is written as a transition but NOTHING reads
 *     it, so "entered by replying" would need a new server-side fact;
 *   · LEAVES at Pending — obtained here by asking only for `new,open`, which matches the rule;
 *   · RETURNS when the customer replies — free, because the reply moves the status back out of
 *     Pending and the predicate picks it up again.
 * ⇒ Two thirds of R17a hold exactly; the entry condition is wider than asked (opened, not replied).
 * Recorded in the plan as W10's finding rather than silently approximated.
 */
const ACTIVE_CATEGORIES = 'new,open';

export function useActiveTickets(): {
  items: ConversationRow[];
  loading: boolean;
  refresh: () => void;
} {
  const dataAccess = useDataAccess();
  const me = useMyOperator();
  const [items, setItems] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const operatorId = me.operatorId;
    // Until `/me/operator` answers there is no "me" to scope by, and a request without the scope
    // would list somebody else's work — the confidently-wrong-answer shape W6 removed from the Inbox.
    if (!operatorId) return;
    let alive = true;
    setLoading(true);
    void dataAccess
      .list<ConversationRow>('conversations', {
        limit: 25,
        filters: {
          assigneeOperatorId: operatorId,
          openedByOperatorId: operatorId,
          statusCategories: ACTIVE_CATEGORIES,
        },
      })
      .then((page) => {
        if (!alive) return;
        setItems(page.items);
        setLoading(false);
      })
      .catch(() => {
        // The tab is an accelerator beside the record, not the record: a failed read shows an empty
        // tab rather than taking the window down with it.
        if (!alive) return;
        setItems([]);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dataAccess, me.operatorId, nonce]);

  return { items, loading, refresh };
}
