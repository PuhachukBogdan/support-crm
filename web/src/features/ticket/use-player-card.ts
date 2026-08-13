'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState } from '@/data/types';
import type { ContactSummaryWire, PlayerWire } from './types';

/**
 * W10 — the right rail's card: who this customer is, and their history with us (roadmap 9.4 + 4.13).
 *
 * Two reads, deliberately independent: identity is `/players/:id` (masked per role by the server)
 * and history is `/players/:id/contact-summary` (counts and timestamps, no contact value can be in
 * it by contract). Either may fail alone and the card degrades in that half only — a missing
 * history must not hide the identity the agent is looking at.
 *
 * ⚠️ Both need the BRAND: the same platform id under two brands is two people (the 07-29 repair),
 * and the server refuses rather than guessing. The brand comes from the conversation, never a
 * default.
 */
export function usePlayerCard(playerId: string, brandId: string) {
  const dataAccess = useDataAccess();
  const [player, setPlayer] = useState<AsyncState<PlayerWire>>({ status: 'idle' });
  const [history, setHistory] = useState<AsyncState<ContactSummaryWire>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // No player attached (or no brand yet): the card renders its own "not identified" state and
    // asks nothing — a read with a blank id would be a 404 dressed as a failure.
    if (!playerId || !brandId) {
      setPlayer({ status: 'idle' });
      setHistory({ status: 'idle' });
      return;
    }
    let alive = true;
    setPlayer({ status: 'loading' });
    setHistory({ status: 'loading' });

    void dataAccess
      .get<PlayerWire>('players', playerId, undefined, { brandId })
      .then((data) => alive && setPlayer({ status: 'ready', data }))
      .catch((e) => alive && setPlayer({ status: 'error', error: toDataError(e) }));

    void dataAccess
      .get<ContactSummaryWire>('player-contact-summary', '', playerId, { brandId })
      .then((data) => alive && setHistory({ status: 'ready', data }))
      .catch((e) => alive && setHistory({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, playerId, brandId, nonce]);

  return { player, history, reload };
}
