'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from './provider';
import { PRESENCE_CHOICES, type PresenceChoice } from './presence';

/**
 * The account's presence PRESETS (`GET /presence/labels`) — W22-доп.
 *
 * ── The shape is a LIST, and that is the lesson this hook replaces ───────────────────────────────
 * ⚠️ Its predecessor (`use-presence-labels.ts`, deleted 2026-08-10) collapsed these rows into a
 * `state → first name` map to RENAME the four states. Live data refused: a `PresenceLabel` is a
 * preset with a reason, and several point at one state (`Break`+`Lunch` are both `away`), so the map
 * dropped one of each pair and renamed a routing behaviour after a reason. This hook keeps every row:
 * the menu offers each preset as its OWN entry below the four states, and choosing one writes
 * `{state, labelId}` — the reason travels with the behaviour instead of replacing its name.
 *
 * ⓘ Server order is preserved — it is the account's own ordering, not an arbitrary pick.
 *
 * ⚠️ FAIL-CLOSED on a row this client cannot vouch for: no id, no name, or a state outside the four
 * the product knows. Offering a click that sets a behaviour this build cannot even name would be
 * worse than omitting the row — same rule the presence dot applies to an unknown state.
 *
 * ⚠️ A failed read returns `[]` silently: presets are decoration over the four states, which keep
 * working — a menu must never lose its base statuses because an optional read did.
 */
export interface PresencePreset {
  readonly id: string;
  readonly name: string;
  readonly state: PresenceChoice;
}

interface PresenceLabelWire {
  id?: string;
  name?: string;
  state?: string;
}

const KNOWN_STATES = new Set<string>(PRESENCE_CHOICES.map((c) => c.state));

export function usePresencePresets(): readonly PresencePreset[] {
  const dataAccess = useDataAccess();
  const [presets, setPresets] = useState<readonly PresencePreset[]>([]);

  useEffect(() => {
    let alive = true;
    void dataAccess
      .list<PresenceLabelWire>('presence-labels', { limit: 50 })
      .then((page) => {
        if (!alive) return;
        setPresets(
          page.items.flatMap((l) => {
            const id = (l.id ?? '').trim();
            const name = (l.name ?? '').trim();
            const state = (l.state ?? '').trim();
            if (!id || !name || !KNOWN_STATES.has(state)) return [];
            return [{ id, name, state: state as PresenceChoice }];
          }),
        );
      })
      .catch(() => {
        if (alive) setPresets([]);
      });
    return () => {
      alive = false;
    };
  }, [dataAccess]);

  return presets;
}
