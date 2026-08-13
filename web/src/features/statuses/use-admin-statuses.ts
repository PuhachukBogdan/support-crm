'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';
import { categoryFromWire, type StatusDef, type StatusWire } from './types';

/**
 * W15a — the status authoring screen's reads and writes (subpoint 3.14).
 *
 * The READ is feature 032's own catalogue route (`conversation-statuses`) — retired rows included,
 * which this screen needs (restoring one is an edit). The WRITES go to `admin-statuses`
 * (`platform.settings.manage`); as on the channels screen, a refused reader gets words, and a
 * reader this list answers holds `crm.inbox.view`, NOT necessarily the write key — so unlike
 * channels, a write refusal here is a real state for a supervisor and stays beside the form.
 */
export function useAdminStatuses() {
  const dataAccess = useDataAccess();
  const [statuses, setStatuses] = useState<AsyncState<StatusDef[]>>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setStatuses({ status: 'loading' });
    void dataAccess
      .list<StatusWire>('conversation-statuses', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        const rows = page.items
          .filter((s): s is StatusWire & { key: string } => typeof s?.key === 'string' && s.key !== '')
          .map((s) => ({
            key: s.key,
            category: categoryFromWire(s.category),
            agentName: s.agentName || s.key,
            endUserName: s.endUserName || '',
            active: s.active !== false,
            order: typeof s.order === 'number' ? s.order : 0,
          }));
        setStatuses(rows.length === 0 ? { status: 'empty' } : { status: 'ready', data: rows });
      })
      .catch((e) => alive && setStatuses({ status: 'error', error: toDataError(e) }));
    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  /** Create — returns the error for the form; the refreshed list is the receipt. */
  const create = useCallback(
    async (input: { category: string; agentName: string; endUserName: string }): Promise<DataError | null> => {
      try {
        await dataAccess.create('admin-statuses', input);
        refresh();
        return null;
      } catch (e) {
        return toDataError(e);
      }
    },
    [dataAccess, refresh],
  );

  /** Edit by KEY — names / category / active (sending `active` is the retire/restore). */
  const update = useCallback(
    async (
      key: string,
      patch: { agentName?: string; endUserName?: string; category?: string; active?: boolean },
    ): Promise<DataError | null> => {
      try {
        await dataAccess.update('admin-statuses', key, patch);
        refresh();
        return null;
      } catch (e) {
        return toDataError(e);
      }
    },
    [dataAccess, refresh],
  );

  return { statuses, refresh, create, update };
}
