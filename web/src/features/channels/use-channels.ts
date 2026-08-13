'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { toDataError } from '@/data/errors';
import type { AsyncState, DataError, PaginatedResult } from '@/data/types';
import type { BrandWire, ChannelWire } from './types';

/**
 * W15 — the channels admin screen's reads and its one write (roadmap 6.8 minimum, subpoint 3.10).
 *
 * Both operations ride ONE key (`platform.settings.manage`), so unlike W14's people screen there is
 * no split to explain: a caller the list answers for may also write, and a caller it refuses gets
 * the refusal in words instead of an empty table (the W11 rule).
 */
export function useChannels() {
  const dataAccess = useDataAccess();
  const [channels, setChannels] = useState<AsyncState<PaginatedResult<ChannelWire>>>({ status: 'idle' });
  const [brands, setBrands] = useState<BrandWire[]>([]);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setChannels({ status: 'loading' });
    void dataAccess
      .list<ChannelWire>('admin-channels', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setChannels(page.items.length === 0 ? { status: 'empty' } : { status: 'ready', data: page });
      })
      .catch((e) => alive && setChannels({ status: 'error', error: toDataError(e) }));

    // Names for the brand column, and the "brands with no mail address yet" candidates. Degrades
    // ALONE: a failed brands read leaves ids on screen, which is worse-looking but still true.
    void dataAccess
      .list<BrandWire>('brands', { limit: 100 })
      .then((page) => alive && setBrands(page.items))
      .catch(() => alive && setBrands([]));

    return () => {
      alive = false;
    };
  }, [dataAccess, nonce]);

  /**
   * Place a brand's mail address (PUT — a brand with no email channel gets one, a brand with one
   * gets its address changed). Returns the error for the FORM to show; the screen-wide state is the
   * list's business.
   */
  const setEmailAddress = useCallback(
    async (brandId: string, address: string): Promise<DataError | null> => {
      try {
        await dataAccess.update('admin-email-channel', brandId, { address });
        refresh();
        return null;
      } catch (e) {
        return toDataError(e);
      }
    },
    [dataAccess, refresh],
  );

  return { channels, brands, refresh, setEmailAddress };
}
