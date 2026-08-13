'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import type { BrandWire } from './types';

/**
 * W11 — the account's brands, for the directory's chooser (roadmap 9.17).
 *
 * The directory cannot ask anything without one: `brandId` is required on the player list, because
 * the same platform id under two brands is two human beings. So this read is the screen's first
 * step, and a failure here is a failure of the screen — reported, not swallowed.
 */
export function useBrands(): { brands: BrandWire[]; loading: boolean; failed: boolean } {
  const dataAccess = useDataAccess();
  const [brands, setBrands] = useState<BrandWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .list<BrandWire>('brands', { limit: 100 })
      .then((page) => {
        if (!alive) return;
        setBrands(page.items);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return { brands, loading, failed };
}
