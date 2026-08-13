'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import type { CannedResponseWire, MacroWire } from './types';

/**
 * W8 — the composer's two pickers: macros and canned responses. Read once per mount; both lists
 * ride `crm.macros.use` since W8 dropped the read gate.
 *
 * A failed read degrades to EMPTY lists and the pickers simply do not render — deliberate, and
 * different from an error banner: a template picker is an accelerator, not the record, and «кнопка,
 * за которой ничего нет, читается как сломанная функция» cuts both ways: an empty dropdown reads
 * as broken; an absent button reads as "not set up", which is the truth of the matter.
 */
export function useTemplates(): { macros: MacroWire[]; canned: CannedResponseWire[] } {
  const dataAccess = useDataAccess();
  const [macros, setMacros] = useState<MacroWire[]>([]);
  const [canned, setCanned] = useState<CannedResponseWire[]>([]);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .list<MacroWire>('macros', { limit: 100 })
      .then((page) => {
        if (alive) setMacros(page.items);
      })
      .catch(() => undefined);
    void dataAccess
      .list<CannedResponseWire>('canned-responses', { limit: 100 })
      .then((page) => {
        if (alive) setCanned(page.items);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return { macros, canned };
}
