'use client';

import { useCallback, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { ContactLookupWire, DetachWarningWire } from './types';

/**
 * W9 / spec 035 — the search-and-attach flow, held locally in the window (ADR 0044 §4/§5).
 *
 * Deliberately NOT in the store: a lookup result is a transient answer to a question the agent
 * just asked, not part of the record. Nothing here persists across a remount, which is the point —
 * a stale "found player X" surviving a ticket switch is how the wrong person gets attached.
 *
 * ⚠️ The searched value never leaves this hook's arguments: it goes into the request body and is
 * not stored in state, so it cannot end up in a re-render, a devtools snapshot or an error string.
 */
export type LookupState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'error'; message: string }
  | { status: 'answered'; result: ContactLookupWire };

export function useContactLookup(conversationId: string) {
  const dataAccess = useDataAccess();
  const [state, setState] = useState<LookupState>({ status: 'idle' });
  const [warning, setWarning] = useState<DetachWarningWire | null>(null);

  const search = useCallback(
    async (kind: 'email' | 'phone', value: string) => {
      if (value.trim() === '') return;
      setState({ status: 'searching' });
      try {
        const result = await dataAccess.update<ContactLookupWire>(
          'conversation-contact-lookup',
          '',
          { kind, value: value.trim() },
          conversationId,
        );
        setState({ status: 'answered', result });
      } catch (e) {
        // The message is the transport's own class (a 403 is "not permitted", a 429 the cap) —
        // never a downstream body, and never the value that was searched.
        setState({ status: 'error', message: toDataError(e).message });
      }
    },
    [dataAccess, conversationId],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  /**
   * ⚠️ 0044 §5: the person is warned BEFORE the detach, not after. This reads the harvest — what
   * staff wrote while this player was attached, all of which STAYS where it was written — and the
   * dialog shows it; {@link detach} is what the confirm button calls.
   */
  const previewDetach = useCallback(async (): Promise<DetachWarningWire | null> => {
    try {
      const res = await dataAccess.get<DetachWarningWire>(
        'conversation-detach-preview',
        '',
        conversationId,
      );
      setWarning(res ?? null);
      return res ?? null;
    } catch (e) {
      setState({ status: 'error', message: toDataError(e).message });
      return null;
    }
  }, [dataAccess, conversationId]);

  const detach = useCallback(async (): Promise<boolean> => {
    try {
      await dataAccess.remove<DetachWarningWire>('conversation-player', '', conversationId);
      setWarning(null);
      return true;
    } catch (e) {
      setState({ status: 'error', message: toDataError(e).message });
      return false;
    }
  }, [dataAccess, conversationId]);

  const attach = useCallback(
    async (playerId: string): Promise<boolean> => {
      try {
        await dataAccess.update('conversation-player', '', { playerId }, conversationId);
        setState({ status: 'idle' });
        return true;
      } catch (e) {
        setState({ status: 'error', message: toDataError(e).message });
        return false;
      }
    },
    [dataAccess, conversationId],
  );

  return {
    state,
    search,
    reset,
    attach,
    previewDetach,
    detach,
    warning,
    clearWarning: () => setWarning(null),
  };
}
