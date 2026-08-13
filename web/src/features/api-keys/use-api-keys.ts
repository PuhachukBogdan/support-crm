'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError } from '@/data/types';
import type { ApiKeyWire, IssueApiKeyBody, IssuedApiKeyWire } from './types';

/**
 * ⭐ W31 (спек №2 / feature 038, roadmap 3.17; ADR 0043 §5) — the reads and writes behind the
 * «API keys» section.
 *
 * ONE read (`admin-api-keys`), and every write ends in a RE-READ of it (the W28 rule — nothing is
 * merged locally): the list renders what the server now holds, including a write it refused.
 *
 * ── ⭐ The one piece of state this hook has that no other admin hook has ──────────────────────────
 * `issued` — the value of a key just minted. It exists because the product shows it EXACTLY ONCE
 * (FR-001): it arrives as the answer to a write, is never part of a read, and `dismissIssued()`
 * drops it. After that it is gone from this process — no cache, no ref, no second copy — which is
 * what makes «we cannot show it again» a true sentence rather than a policy.
 *
 * ⚠️ The re-read that follows a write deliberately does NOT touch `issued`: the two are separate
 * pieces of state precisely so that refreshing the list cannot blank the panel out from under the
 * administrator mid-copy, and so that no read can ever be the thing that produces a value.
 */
export function useApiKeys() {
  const dataAccess = useDataAccess();
  const [keys, setKeys] = useState<AsyncState<ApiKeyWire[]>>({ status: 'idle' });
  const [mutation, setMutation] = useState<DataError | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [issued, setIssued] = useState<IssuedApiKeyWire | null>(null);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setKeys((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    void dataAccess
      .list<ApiKeyWire>('admin-api-keys', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setKeys(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page.items });
      })
      .catch((e) => alive && setKeys({ status: 'error', error: toDataError(e) }));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  /** One write shape for all three acts; the re-read is the standing effect above (via nonce). */
  const write = useCallback(
    async (key: string, fn: () => Promise<unknown>): Promise<unknown | null> => {
      setMutation(null);
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
   * The answer's `value` is shown, not stored: it goes into `issued` and nowhere else. A server that
   * answered without one is not a reason to show an empty panel claiming to hold a secret — the
   * write still succeeded, and the list is re-read either way.
   */
  const showValue = (result: unknown): void => {
    const answer = result as IssuedApiKeyWire | null;
    if (answer && typeof answer.value === 'string' && answer.value !== '') setIssued(answer);
  };

  const issue = useCallback(
    async (body: IssueApiKeyBody) => {
      const result = await write('key-new', () =>
        dataAccess.create<IssuedApiKeyWire>('admin-api-keys', body),
      );
      if (result === null) return false;
      showValue(result);
      return true;
    },
    [dataAccess, write],
  );

  /**
   * Rotation is an ACT on one key, not an edit of it — POST to a child path (`admin-api-key-rotate`,
   * a singleton under `{within}` = the key). The old value stops the moment the new one is minted,
   * which is why the screen asks first.
   */
  const rotate = useCallback(
    async (id: string) => {
      const result = await write(`key-${id}`, () =>
        dataAccess.update<IssuedApiKeyWire>('admin-api-key-rotate', '', {}, id),
      );
      if (result === null) return false;
      showValue(result);
      return true;
    },
    [dataAccess, write],
  );

  /** Revocation is a DELETE on the surface and never an erasure underneath (ADR 0043 §3/§5). */
  const revoke = useCallback(
    (id: string) => write(`key-${id}`, () => dataAccess.remove('admin-api-keys', id)).then((r) => r !== null),
    [dataAccess, write],
  );

  /** The value is dropped, not hidden — see the header. There is no way back to it but rotation. */
  const dismissIssued = useCallback(() => setIssued(null), []);

  return { keys, issued, mutation, busyKey, refresh, issue, rotate, revoke, dismissIssued };
}
