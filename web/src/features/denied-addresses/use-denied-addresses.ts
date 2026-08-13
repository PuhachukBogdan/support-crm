'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';
import type {
  AddDeniedAddressBody,
  AddDeniedAddressResult,
  DeniedAddressWire,
  RemoveDeniedAddressResult,
  WriteOutcome,
} from './types';

/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.10) — the reads and writes behind «Denied addresses».
 *
 * ONE read (`admin-denied-addresses`), and every write ends in a RE-READ of it (the W28 rule, kept
 * from `use-api-keys.ts` — nothing is merged locally). It matters more here than on most screens:
 * the server stores the NORMALISED address (FR-029), so what an administrator typed and what the
 * boundary compares are not the same string. A locally-merged row would show the typed form and
 * quietly teach them that a ban exists for an address the product never compares.
 *
 * ── ⭐ The two «nothing happened» answers are SUCCESSES, and this hook is where that is decided ───
 * `created: false` (already listed) and `removed: false` (already gone) both arrive as ordinary 200s.
 * They become a `notice` — a sentence, in the neutral register — never a `mutation` error. Rendering
 * either as a failure would teach an administrator that a control they used correctly is broken, and
 * the next thing they do is try to «fix» a list that was already right.
 *
 * ── ⓘ The people map degrades ALONE (the audit-log precedent) ────────────────────────────────────
 * `createdBy` is an opaque id. It is joined to an email through the staff list, which rides a
 * different permission (`users.list.view`); when that read is refused or fails, the rows show ids —
 * worse-looking, still true — and nothing else on the screen is affected.
 */

interface StaffWire {
  userId?: string;
  email?: string;
}

export function useDeniedAddresses() {
  const dataAccess = useDataAccess();
  const [addresses, setAddresses] = useState<AsyncState<DeniedAddressWire[]>>({ status: 'idle' });
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [people, setPeople] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setAddresses((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .list<DeniedAddressWire>('admin-denied-addresses', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setAddresses(
          page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page.items },
        );
      })
      .catch((e) => alive && setAddresses({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .list<StaffWire>('staff', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        const map = new Map<string, string>();
        for (const p of page.items) if (p.userId && p.email) map.set(p.userId, p.email);
        setPeople(map);
      })
      // Deliberately silent: a refused people list is not a failure of THIS screen, and an error
      // banner about a join would send an administrator looking for a problem with the deny-list.
      .catch(() => undefined);

    return () => {
      alive = false;
    };
  }, [dataAccess]);

  /** One write shape for both acts; the re-read is the standing effect above (via nonce). */
  const write = useCallback(
    async (key: string, fn: () => Promise<unknown>): Promise<unknown | null> => {
      setMutation(null);
      setNotice(null);
      setBusyKey(key);
      try {
        const result = await fn();
        refresh();
        return result ?? {};
      } catch (e) {
        setMutation(toDataError(e));
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  /**
   * Add one address.
   *
   * ⚠️ The refusal message is chosen from the failure CLASS, never from a response body — the
   * transport never reads one (`data/errors.ts`, and the reason is written there). The one 400 this
   * route produces is `invalid_address`, so `invalid-request` here means exactly one thing and the
   * screen may say it plainly instead of showing «The request was not valid.» about a typed address.
   */
  const add = useCallback(
    async (body: AddDeniedAddressBody): Promise<WriteOutcome> => {
      const result = await write('add', () =>
        dataAccess.create<AddDeniedAddressResult>('admin-denied-addresses', body),
      );
      if (result === null) {
        setMutation((m) =>
          m && m.code === 'invalid-request'
            ? {
                ...m,
                message:
                  'That address was not accepted, so nothing was saved. It has to be a single IP address — 203.0.113.10, or an IPv6 one. A range, a host name or a partial address is not something the boundary can compare.',
              }
            : m,
        );
        return 'refused';
      }

      const answer = result as AddDeniedAddressResult;
      if (answer.created === true) return 'saved';

      // The quiet success. The server's own stored form is preferred over what was typed: it is what
      // the boundary compares, and seeing it is how an administrator learns the two can differ.
      const stored = answer.address?.address ?? body.address;
      setNotice(
        `${stored} was already on the list, so nothing changed. Adding it twice is the same intent expressed twice — it is refused exactly as it was before.`,
      );
      return 'unchanged';
    },
    [dataAccess, write],
  );

  const remove = useCallback(
    async (id: string, address: string): Promise<WriteOutcome> => {
      const result = await write(`remove-${id}`, () =>
        dataAccess.remove<RemoveDeniedAddressResult>('admin-denied-addresses', id),
      );
      if (result === null) return 'refused';

      const answer = result as RemoveDeniedAddressResult;
      if (answer.removed === true) return 'saved';

      setNotice(
        `${address} was already off the list — somebody else removed it. Nothing changed, and requests from it are accepted.`,
      );
      return 'unchanged';
    },
    [dataAccess, write],
  );

  /** The people map is a JOIN, never a source: an id with no match renders as itself. */
  const nameFor = useCallback((userId: string) => people.get(userId) ?? userId, [people]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { addresses, mutation, notice, busyKey, refresh, add, remove, nameFor, dismissNotice };
}
