'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDataAccess } from '@/data/provider';
import { useSession } from '@/session';
import {
  playUnreadChime,
  setUnreadSoundEnabled,
  unreadSoundEnabled,
} from '@/lib/unread-chime';

interface UnseenWire {
  count?: number;
  openedAt?: string;
}
interface UiPreferencesWire {
  values?: Record<string, string>;
}

/**
 * ⭐ W25 (R23 / 9.12) — the unread badge's client half. The COUNT is never accumulated here: every
 * change of state is a re-read of the server's derived number, so a reload, a second tab and a
 * mid-air event all agree (the theme lesson: the receipt is the server's state).
 *
 * ── The operator's four rules, and which half owns each ─────────────────────────────────────────
 * · closed + arrives → +1 — a realtime event (or the 60s poll, when realtime is off) triggers a
 *   refetch, and the server's predicate has one more row;
 * · open + arrives → NO increment — the Inbox page re-marks itself on arrivals while mounted, and
 *   this hook shows NOTHING on the Inbox route anyway (belt and braces — a transient race between
 *   the two requests cannot flash a number nobody should see);
 * · opening resets — the page PUTs the mark; the badge's next read is 0;
 * · 99+ — display only, in the component; the number itself travels uncapped.
 *
 * ── The sound (R23's second half) ────────────────────────────────────────────────────────────────
 * Rings when the count GROWS while the person is elsewhere — which is by construction «только на
 * свои»: the server counts the caller's own slice, so somebody else's ticket cannot move this
 * number. The personal switch is `unread_sound` (ui-preferences); its cache makes a toggle apply
 * without a reload. Autoplay policy is respected in the chime itself.
 */
export function useUnseenInbox(): { count: number; onInbox: boolean } {
  const dataAccess = useDataAccess();
  const pathname = usePathname();
  const { state } = useSession();
  const authenticated = state.kind === 'authenticated';
  const [count, setCount] = useState(0);
  // `null` until the first read lands: the number that was already there when the badge mounted is
  // BACKLOG, not an arrival — a sign-in must never open with a chime about yesterday.
  const prev = useRef<number | null>(null);
  const onInboxRef = useRef(false);

  const onInbox = pathname === '/';
  onInboxRef.current = onInbox;

  const refetch = useCallback(() => {
    void dataAccess
      .get<UnseenWire>('inbox-unseen', '')
      .then((res) => {
        const next = res?.count ?? 0;
        setCount(next);
        // GROWS while the person is elsewhere → the quiet chime (default ON per the catalogue).
        // The first read is backlog, never an arrival — see `prev`'s null above.
        if (prev.current !== null && next > prev.current && !onInboxRef.current && unreadSoundEnabled() !== false) {
          playUnreadChime();
        }
        prev.current = next;
      })
      .catch(() => {
        // The badge degrades to its last value; a failed read must not invent zero (that would
        // dismiss arrivals nobody saw) and must not surface an error in the chrome.
      });
  }, [dataAccess]);

  useEffect(() => {
    if (!authenticated) return;
    refetch();
    // Warm the sound-switch cache once per mount; the settings toggle keeps it current after that.
    void dataAccess
      .get<UiPreferencesWire>('ui-preferences', '')
      .then((res) => {
        const v = res?.values?.unread_sound;
        if (v === 'on' || v === 'off') setUnreadSoundEnabled(v === 'on');
      })
      .catch(() => {});
    const unsubscribe = dataAccess.subscribe((event) => {
      // Any conversation-shaped change may move the derived number; `reconnected` is exactly the
      // interval events were missed for. The server decides — the client never guesses "is it mine".
      if (
        event.kind === 'conversation.created' ||
        event.kind === 'conversation.updated' ||
        event.kind === 'reconnected'
      ) {
        refetch();
      }
    });
    // The safety net for a realtime-off deployment: the badge is eventually right within a minute.
    const timer = setInterval(refetch, 60_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [authenticated, dataAccess, refetch]);

  // Opening the Inbox resets server-side (the page's own act); reflect it immediately here too so
  // navigating Inbox → elsewhere never flashes the pre-reset number.
  useEffect(() => {
    if (onInbox) {
      setCount(0);
      prev.current = 0;
    }
  }, [onInbox]);

  return { count, onInbox };
}
