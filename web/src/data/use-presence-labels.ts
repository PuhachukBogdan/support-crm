'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from './provider';

/**
 * The account's own words for the four presence states (`GET /presence/labels`).
 *
 * ── Why this hook exists at all ──────────────────────────────────────────────────────────────────
 * ⚠️ Not a nicety — a contract. `Break` · `Lunch` · `Meeting` · `VIP task` are rows an administrator
 * edits (ADR 0042 §7), and `tests/contracts/presence-label-never-branched-on.spec.ts` fails the build
 * the moment a screen writes one as a literal: *"The seed may name them; the product may not. A
 * literal here is how an editable word quietly becomes a constant."* This hook is the legitimate way
 * to put the administrator's word on screen — read at runtime, never compiled in.
 *
 * ⓘ A label carries the STATE it sets, so several labels can share one state («Lunch» and «Meeting»
 * are both `away`). For naming a state we take the FIRST label the account lists for it — the read
 * preserves server order, so that is the account's own preference and not an arbitrary pick.
 *
 * ⚠️ A failure is silent and returns `{}` on purpose: the caller then falls back to the built-in plain
 * wording in `@/data/presence`. Decoration must never take a screen down — and presence itself keeps
 * working, because the four STATES are the closed set the server validates, not these words.
 */
interface PresenceLabelWire {
  id?: string;
  name?: string;
  state?: string;
}

export function usePresenceLabels(): Readonly<Record<string, string>> {
  const dataAccess = useDataAccess();
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let alive = true;
    void dataAccess
      .list<PresenceLabelWire>('presence-labels', { limit: 50 })
      .then((page) => {
        if (!alive) return;
        const map: Record<string, string> = {};
        for (const l of page.items) {
          const state = (l.state ?? '').trim();
          const name = (l.name ?? '').trim();
          // First one per state wins; an empty name is not a name.
          if (state && name && !(state in map)) map[state] = name;
        }
        setNames(map);
      })
      .catch(() => {
        if (alive) setNames({});
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return names;
}
