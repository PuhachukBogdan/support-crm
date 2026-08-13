'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError, PaginatedResult } from '@/data/types';
import type { GroupWire, StaffWire } from '@/features/people/types';
import type { CatalogueWire, PersonPermissionsWire, RoleDefaultsWire, Scope } from './types';

/**
 * ⭐⭐ W28 (9.8, R45) — the one window's reads and writes.
 *
 * Every write goes through the engine's audited routes and ends in a RE-READ of the scope it
 * touched: nothing is merged locally, so a toggle shows what the server now holds — including a
 * write the server refused (the toggle simply stays where the truth is). The engine invalidates
 * the target's effective-permission cache per write, which is what makes «действует в той же
 * сессии» the server's property rather than this screen's promise.
 */
export function useAccess() {
  const dataAccess = useDataAccess();
  const [staff, setStaff] = useState<AsyncState<PaginatedResult<StaffWire>>>({ status: 'idle' });
  const [groups, setGroups] = useState<AsyncState<PaginatedResult<GroupWire>>>({ status: 'idle' });
  const [catalogue, setCatalogue] = useState<AsyncState<CatalogueWire>>({ status: 'idle' });
  const [scope, setScope] = useState<Scope | null>(null);
  /** The current scope's truth: person facts, role defaults, or the group's grant list. */
  const [person, setPerson] = useState<AsyncState<PersonPermissionsWire>>({ status: 'idle' });
  const [roleDefaults, setRoleDefaults] = useState<AsyncState<RoleDefaultsWire>>({ status: 'idle' });
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // ── the window's three standing reads ───────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setStaff((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .list<StaffWire>('staff', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setStaff(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      .catch((e) => alive && setStaff({ status: 'error', error: toDataError(e) }));

    setGroups((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .list<GroupWire>('groups', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setGroups(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      .catch((e) => alive && setGroups({ status: 'error', error: toDataError(e) }));
    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  useEffect(() => {
    let alive = true;
    setCatalogue({ status: 'loading' });
    void dataAccess
      .get<CatalogueWire>('access-catalogue', '')
      .then((c) => alive && setCatalogue({ status: 'ready', data: c }))
      .catch((e) => alive && setCatalogue({ status: 'error', error: toDataError(e) }));
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  // ── the selected scope's truth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setPerson({ status: 'idle' });
    setRoleDefaults({ status: 'idle' });
    if (scope?.kind === 'person') {
      setPerson({ status: 'loading' });
      void dataAccess
        .get<PersonPermissionsWire>('staff-permissions', scope.userId)
        .then((p) => alive && setPerson({ status: 'ready', data: p }))
        .catch((e) => alive && setPerson({ status: 'error', error: toDataError(e) }));
    }
    if (scope?.kind === 'role') {
      setRoleDefaults({ status: 'loading' });
      void dataAccess
        .get<RoleDefaultsWire>('role-defaults', scope.roleKey)
        .then((r) => alive && setRoleDefaults({ status: 'ready', data: r }))
        .catch((e) => alive && setRoleDefaults({ status: 'error', error: toDataError(e) }));
    }
    return () => {
      alive = false;
    };
  }, [dataAccess, scope, nonce]);

  /** One write shape for every scope; the re-read is the scope's own effect above (via nonce). */
  const write = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setMutation(null);
      setBusyKey(key);
      try {
        await fn();
        refresh();
        return true;
      } catch (e) {
        setMutation(toDataError(e));
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const togglePerson = useCallback(
    (userId: string, permissionKey: string, grant: boolean) =>
      write(permissionKey, () =>
        dataAccess.update('staff-permissions', userId, { permissionKey, grant }),
      ),
    [dataAccess, write],
  );

  const toggleRole = useCallback(
    (roleKey: string, permissionKey: string, grant: boolean) =>
      write(permissionKey, () =>
        dataAccess.update('role-permissions', roleKey, { permissionKey, grant }),
      ),
    [dataAccess, write],
  );

  const toggleGroup = useCallback(
    (groupId: string, permissionKey: string, grant: boolean) =>
      write(permissionKey, () =>
        grant
          ? dataAccess.update('group-permissions', permissionKey, {}, groupId)
          : dataAccess.remove('group-permissions', permissionKey, groupId),
      ),
    [dataAccess, write],
  );

  const applySelection = useCallback(
    (userIds: string[], permissionKey: string, grant: boolean) =>
      write(permissionKey, () =>
        dataAccess.update('selection-permissions', '', { userIds, permissionKey, grant }),
      ),
    [dataAccess, write],
  );

  /**
   * «Вернуть как было» — the engine's reset, at whichever scope is on screen. The scope words are
   * the engine's own (`user | selection | role`, override.service.ts); a GROUP has no reset — its
   * grants are explicit rows with no default to return to, so the screen never offers one there.
   */
  const reset = useCallback(
    (s: Scope) =>
      write('__reset__', () =>
        dataAccess.create(
          'access-reset',
          s.kind === 'person'
            ? { scope: 'user', userId: s.userId }
            : s.kind === 'selection'
              ? { scope: 'selection', userIds: s.userIds }
              : { scope: 'role', roleKey: s.kind === 'role' ? s.roleKey : '' },
        ),
      ),
    [dataAccess, write],
  );

  /** The role handed out in the SAME window (R45) — the control that left /admin/people. */
  const setRole = useCallback(
    (userId: string, roleKey: string) =>
      write('__role__', () => dataAccess.update('staff-role', userId, { roleKey, op: 'assign' })),
    [dataAccess, write],
  );

  return {
    staff,
    groups,
    catalogue,
    scope,
    setScope,
    person,
    roleDefaults,
    mutation,
    busyKey,
    togglePerson,
    toggleRole,
    toggleGroup,
    applySelection,
    reset,
    setRole,
    refresh,
  };
}
