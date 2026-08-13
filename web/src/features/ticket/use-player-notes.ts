'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';

/**
 * W35 / feature 040 — the ONE read path for player notes (R35 · U17).
 *
 * ⚠️ **One hook, two surfaces.** The ticket window's player card and the full player page both mount the
 * same component over this hook, which is W11's rule stated on its own page: *"the two surfaces must
 * never disagree about the same customer, and a second read path is how they would."* A second fetch
 * here would be the same defect one floor down.
 *
 * ── The warning is the SERVER's answer, and this hook holds it ────────────────────────────────────
 * Adding a note can end in three places, not two: stored, refused, or **answered with a warning**. The
 * third is a 200 in which nothing was written, carrying which kinds of contact-shaped text the body
 * contains (`phone` · `email` · `handle`). The composer then shows it, KEEPS the author's text, and the
 * same body sent with `acknowledged: true` is stored.
 *
 * There is deliberately no browser-side detector: `web/` imports nothing from the services' shared
 * library, so a copy of that rule here would be a second implementation of a security check — the
 * divergence-with-a-delay-fuse the repo's single-policy guard exists to prevent. It also could not be
 * trusted, since a client can skip it.
 */

export interface PlayerNoteWire {
  id: string;
  body: string;
  /** The AUTH identity of the author — the stable fact, shown when no name resolves. */
  authorRef: string;
  /** Empty when no operator profile resolves (the author has left, or never had one). */
  authorDisplayName: string;
  createdAt: string;
  /** What the author was warned about when they added it, if anything. */
  patternKinds: string[];
}

/** What the composer is currently being told. `null` = nothing pending. */
export interface PendingWarning {
  kinds: string[];
  /** The exact body the warning is about — re-sent verbatim on acknowledgement. */
  body: string;
}

export interface UsePlayerNotes {
  notes: AsyncState<PlayerNoteWire[]>;
  /** A save in flight — the composer disables its button and says so. */
  saving: boolean;
  /** The server's warning, awaiting the author's decision. */
  warning: PendingWarning | null;
  /** A failed save, separate from a failed READ: the list is fine, the write is not. */
  saveError: DataError | null;
  /**
   * Add a note. Returns true when a row was stored, false when the server answered with a warning or
   * an error — the caller keeps the text in either of those cases.
   */
  add(body: string, opts?: { acknowledged?: boolean }): Promise<boolean>;
  /** Dismiss the warning without sending (the author is going back to edit). */
  dismissWarning(): void;
  reload(): void;
}

/**
 * A fresh idempotence reference per compose action.
 *
 * ⚠️ It exists so a RETRY is one row rather than two: the server keys idempotence on this and never on
 * the body, because two identical observations on different days are two facts. `crypto.randomUUID` is
 * available in every browser this product supports; the fallback keeps a jsdom test from needing a
 * polyfill, and cannot collide in practice because it is only ever compared within one account.
 */
function newClientRef(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface AddResponse {
  outcome?: string;
  note?: PlayerNoteWire;
  patternKinds?: string[];
  replayed?: boolean;
}

export function usePlayerNotes(playerId: string, brandId: string): UsePlayerNotes {
  const dataAccess = useDataAccess();
  const [notes, setNotes] = useState<AsyncState<PlayerNoteWire[]>>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState<PendingWarning | null>(null);
  const [saveError, setSaveError] = useState<DataError | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    // No player (or no brand yet): ask nothing. A read with a blank id is a 404 dressed as a failure.
    if (!playerId || !brandId) {
      setNotes({ status: 'idle' });
      return;
    }
    let alive = true;
    setNotes({ status: 'loading' });

    void dataAccess
      .list<PlayerNoteWire>('player-notes', {
        limit: 50,
        within: playerId,
        filters: { brandId },
      })
      .then((page) => alive && setNotes({ status: 'ready', data: page.items }))
      // ⚠️ A 403 lands here like any other failure, and that is correct: the component decides what a
      // refusal LOOKS like (the area is absent, not empty), because "you may not read these" and "the
      // read broke" must not render the same way.
      .catch((e) => alive && setNotes({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, playerId, brandId, nonce]);

  const add = useCallback(
    async (body: string, opts?: { acknowledged?: boolean }): Promise<boolean> => {
      if (!playerId || !brandId || !body.trim()) return false;
      setSaving(true);
      setSaveError(null);
      try {
        const res = await dataAccess.create<AddResponse>(
          'player-notes',
          {
            brandId,
            body,
            acknowledged: opts?.acknowledged === true,
            clientRef: newClientRef(),
          },
          playerId,
        );

        if (res?.outcome === 'needs_acknowledgement') {
          // Nothing was stored. Hold the warning AND the body it is about, so acknowledging re-sends
          // exactly what the server judged rather than whatever the box contains a moment later.
          setWarning({ kinds: res.patternKinds ?? [], body });
          return false;
        }

        if (res?.outcome === 'stored' && res.note) {
          setWarning(null);
          // Prepended locally rather than by re-reading: the response carries the note the next read
          // would return (author name included), so the list stays honest without a round trip.
          setNotes((prev) =>
            prev.status === 'ready'
              ? { status: 'ready', data: [res.note!, ...prev.data.filter((n) => n.id !== res.note!.id)] }
              : { status: 'ready', data: [res.note!] },
          );
          return true;
        }

        // An outcome nobody declared is a failure, never a success (the wire drops zero values).
        setSaveError(toDataError(new Error('unexpected response')));
        return false;
      } catch (e) {
        setSaveError(toDataError(e));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [dataAccess, playerId, brandId],
  );

  const dismissWarning = useCallback(() => setWarning(null), []);

  return { notes, saving, warning, saveError, add, dismissWarning, reload };
}
