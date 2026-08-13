'use client';

import { useEffect } from 'react';
import { useDataAccess } from '@/data/provider';

/**
 * The window's live subscription (W7 — «подписка на события», subpoint 2.6).
 *
 * Same contract as the Inbox's `useLiveRefresh` (W4): the event carries IDS ONLY, so the reaction
 * is always *re-read through the read path* — never a merge; that is where account scope, RBAC and
 * the private-note filter live.
 *
 * Two differences, both because this screen is ONE conversation:
 *  · it refreshes only for ITS conversation id — an account-wide event stream would otherwise
 *    re-read this window on every message anyone receives;
 *  · `reconnected` carries no ids ON PURPOSE (the downtime is exactly the unknown), so it always
 *    refreshes — "connected again" is not "up to date".
 *
 * ⓘ No paged-hold-off here: the thread saga drains whole and the refresh keeps screen content
 * until the answer lands (the slice's no-flash rule), so a mid-read refresh cannot yank scroll.
 */
export function useTicketLive(id: string, refresh: () => void): void {
  const dataAccess = useDataAccess();

  useEffect(() => {
    return dataAccess.subscribe((event) => {
      if (event.kind === 'reconnected' || event.conversationId === id) refresh();
    });
  }, [dataAccess, id, refresh]);
}
