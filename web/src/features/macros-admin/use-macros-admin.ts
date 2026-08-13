'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError, PaginatedResult } from '@/data/types';
import type { MacroWire } from '@/features/ticket/types';
import type { GroupWire } from '@/features/people/types';

export interface StatusOption {
  key: string;
  agentName: string;
  active: boolean;
}

export interface NewMacroAction {
  type: 'set_status' | 'set_priority' | 'set_category' | 'set_sub_category';
  value: string;
}

/**
 * ⭐ W29 (R46) — the authoring screen's reads and writes.
 *
 * Groups degrade ALONE: the availability picker needs `platform.group.manage` (admins), while a
 * teamlead authors macros without it — their macros are simply unscoped, and the picker is absent
 * rather than broken (the people-screen precedent, one screen over).
 */
export function useMacrosAdmin() {
  const dataAccess = useDataAccess();
  const [macros, setMacros] = useState<AsyncState<PaginatedResult<MacroWire>>>({ status: 'idle' });
  const [groups, setGroups] = useState<AsyncState<PaginatedResult<GroupWire>>>({ status: 'idle' });
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setMacros((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .list<MacroWire>('macros', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setMacros(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      .catch((e) => alive && setMacros({ status: 'error', error: toDataError(e) }));

    void dataAccess
      .list<GroupWire>('groups', { limit: 100 })
      .then((page) => alive && setGroups({ status: 'ready', data: page }))
      // Degrades ALONE — see the header.
      .catch((e) => alive && setGroups({ status: 'error', error: toDataError(e) }));

    void dataAccess
      .list<StatusOption>('conversation-statuses', { limit: 100 })
      .then((page) => alive && setStatuses(page.items.filter((s) => s.active)))
      .catch(() => alive && setStatuses([]));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  const create = useCallback(
    async (input: { name: string; text: string; groupIds: string[]; actions: NewMacroAction[] }) => {
      setMutation(null);
      setBusy(true);
      try {
        await dataAccess.create('macros', {
          name: input.name,
          text: input.text,
          groupIds: input.groupIds,
          actions: input.actions,
        });
        refresh();
        return true;
      } catch (e) {
        setMutation(toDataError(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [dataAccess, refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setMutation(null);
      setBusy(true);
      try {
        await dataAccess.remove('macros', id);
        refresh();
        return true;
      } catch (e) {
        setMutation(toDataError(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [dataAccess, refresh],
  );

  return { macros, groups, statuses, mutation, busy, create, remove, refresh };
}
