'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError, PaginatedResult } from '@/data/types';
import type { GroupWire, StaffWire } from './types';

/**
 * W14 — the admin screen's reads and writes (roadmap 3.8 + 3.9).
 *
 * ⚠️ **Two authorization models on one screen, and the hook does not hide that.** The people LIST
 * is `users.list.view` (a supervisory read); changing a ROLE is super-admin only; groups are
 * `platform.group.manage`. A teamlead therefore sees the list and gets a refusal on the role
 * control — so each mutation reports its own error rather than one screen-wide banner that would
 * blame the wrong thing.
 */
export function usePeople() {
  const dataAccess = useDataAccess();
  const [staff, setStaff] = useState<AsyncState<PaginatedResult<StaffWire>>>({ status: 'idle' });
  const [groups, setGroups] = useState<AsyncState<PaginatedResult<GroupWire>>>({ status: 'idle' });
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setStaff({ status: 'loading' });
    void dataAccess
      .list<StaffWire>('staff', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setStaff(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      .catch((e) => alive && setStaff({ status: 'error', error: toDataError(e) }));

    setGroups({ status: 'loading' });
    void dataAccess
      .list<GroupWire>('groups', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setGroups(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      // Groups degrade ALONE: `platform.group.manage` and `users.list.view` are different keys, so
      // one half of this screen being refused must not blank the other.
      .catch((e) => alive && setGroups({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  const setRole = useCallback(
    async (userId: string, roleKey: string) => {
      setMutation(null);
      try {
        await dataAccess.update('staff-role', userId, { roleKey, op: 'assign' });
        refresh();
        return true;
      } catch (e) {
        // ⚠️ A 403 here is the honest answer for a teamlead: they may see the list and may not
        // change what anybody is. The message says which, and the list stays on screen.
        setMutation(toDataError(e));
        return false;
      }
    },
    [dataAccess, refresh],
  );

  const setMembership = useCallback(
    async (groupId: string, userId: string, member: boolean) => {
      setMutation(null);
      try {
        if (member) await dataAccess.update('group-members', userId, undefined, groupId);
        else await dataAccess.remove('group-members', userId, groupId);
        refresh();
        return true;
      } catch (e) {
        setMutation(toDataError(e));
        return false;
      }
    },
    [dataAccess, refresh],
  );

  /**
   * W14 remainder (roadmap 3.8) — issue an invitation through the feature-010 engine. Returns the
   * error rather than setting `mutation`: the outcome belongs BESIDE the form (which stays open on
   * failure), not in the screen-wide banner that talks about the list. On success the list is
   * refreshed, because the engine pre-creates the person as `invited` — the row appearing IS the
   * visible receipt that something happened.
   */
  const invite = useCallback(
    async (email: string, roleKey: string): Promise<DataError | null> => {
      try {
        await dataAccess.create('invites', { email, role: roleKey });
        refresh();
        return null;
      } catch (e) {
        return toDataError(e);
      }
    },
    [dataAccess, refresh],
  );

  return { staff, groups, mutation, refresh, setRole, setMembership, invite };
}

/** The membership of ONE desk, read on demand — the list route returns counts, not member ids. */
export function useGroupMembers(groupId: string, nonce = 0) {
  const dataAccess = useDataAccess();
  const [userIds, setUserIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!groupId) {
      setUserIds(null);
      return;
    }
    let alive = true;
    void dataAccess
      .list<string>('group-members', { limit: 100, within: groupId })
      .then((page) => alive && setUserIds(page.items))
      .catch(() => alive && setUserIds([]));
    return () => {
      alive = false;
    };
  }, [dataAccess, groupId, nonce]);

  return userIds;
}
