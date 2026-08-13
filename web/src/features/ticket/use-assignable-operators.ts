'use client';

import { useEffect, useState } from 'react';
import { useDataAccess } from '@/data/provider';
import { useSession } from '@/session';
import type { PaginatedResult } from '@/data/types';

/**
 * ⭐ 2026-08-10 — who a ticket may be handed to, by NAME.
 *
 * The operator, on the shipped ticket window: *«я всё ещё не вижу возможности менять поля типа бренд,
 * ассайни»*. Assignee had exactly one control — «take it», which can only name the caller (5.11's
 * shape) — and rendered a raw `Operator.id` otherwise. So handing a ticket to a named colleague was
 * unreachable from the product, and the field showed a UUID nobody can read.
 *
 * ── Two reads, because the answer genuinely lives in two services ────────────────────────────────
 * The name is an AUTH fact and the assignable id is a USERS fact, and they are joined on
 * `authUserId`:
 *
 *   1. `staff`  → `GET /admin/access/users` (`users.list.view`) — who works here, and their names.
 *   2. `assignable-operators` → `GET /operators?authUserIds=…` (`crm.conversation.assign`) — the
 *      auth-identity → `Operator.id` translation, which is what an assignment actually points at,
 *      plus the presence that rides that rpc's answer.
 *
 * ⚠️ **A person absent from read 2 is NOT assignable, and is dropped rather than shown greyed.** The
 * rpc answers with ACTIVE profiles only, and its own contract says so: *"a member with no profile, or
 * with an inactive one, is simply ABSENT — and is therefore not a routing candidate (fail-closed)."*
 * Offering them would be offering a control that 400s.
 *
 * ── Why the chooser can be absent for somebody who may still assign ─────────────────────────────
 * ⓘ A `support_agent` holds `crm.conversation.assign` but NOT `users.list.view` — so read 1 is
 * refused and this hook returns an empty list. That is the honest outcome, not a gap: without the
 * staff directory there are no names to offer, and «take it» (which needs neither read) stays. Naming
 * a colleague is a lead-level act in this product's own matrix; the field says so by offering nothing
 * else. RENDER-only either way — the server re-checks both keys regardless.
 */
export interface AssignableOperator {
  /** What an assignment points at — `Operator.id`, never the auth user id. */
  operatorId: string;
  /** The person's own name, or their email when they have never set one (never a fabricated one). */
  displayName: string;
  /** `online | transfers_only | away | offline` — fail-closed to `offline` on anything unrecognised. */
  state: string;
}

interface StaffRow {
  userId?: string;
  email?: string;
  displayName?: string;
  status?: string;
}
interface ResolvedRow {
  operatorId?: string;
  authUserId?: string;
  state?: string;
}

/** The bound the staff list itself uses (W14). Restated so this read cannot become an unbounded one. */
const STAFF_LIMIT = 100;

export function useAssignableOperators(): {
  operators: AssignableOperator[];
  /** True while either read is in flight — the chooser shows the current value, not a flicker. */
  loading: boolean;
} {
  const dataAccess = useDataAccess();
  const session = useSession();
  const [operators, setOperators] = useState<AssignableOperator[]>([]);
  const [loading, setLoading] = useState(false);

  const keys = session.state.kind === 'authenticated' ? session.state.permissionKeys : [];
  // Both keys, because both reads are needed for a usable option. Checked before asking rather than
  // after a 403: a refusal here is expected for most roles, not an error worth reporting.
  const may = keys.includes('users.list.view') && keys.includes('crm.conversation.assign');

  useEffect(() => {
    if (!may) {
      setOperators([]);
      return;
    }
    let alive = true;
    setLoading(true);

    void (async () => {
      try {
        const staff: PaginatedResult<StaffRow> = await dataAccess.list('staff', {
          limit: STAFF_LIMIT,
        });
        // `disabled` and `invited` people cannot take work. Filtered here as a courtesy; read 2 is
        // what actually decides, since it returns active PROFILES only.
        const rows = staff.items.filter((s) => (s.userId ?? '') !== '' && s.status === 'active');
        if (rows.length === 0) {
          if (alive) setOperators([]);
          return;
        }

        const ids = rows.map((s) => s.userId ?? '');
        const resolved = await dataAccess.get<{ operators?: ResolvedRow[] }>(
          'assignable-operators',
          '',
          undefined,
          { authUserIds: ids.join(',') },
        );

        const byAuthUser = new Map<string, ResolvedRow>();
        for (const r of resolved?.operators ?? []) {
          if (r.authUserId && r.operatorId) byAuthUser.set(r.authUserId, r);
        }

        const joined = rows
          .map((s) => {
            const match = byAuthUser.get(s.userId ?? '');
            if (!match) return null;
            return {
              operatorId: match.operatorId ?? '',
              // The email is the fallback the staff screen already uses — a real value a colleague
              // recognises, where an auto-generated stand-in name is forbidden outright (ADR 0044 §1).
              displayName: (s.displayName ?? '').trim() || (s.email ?? '').trim() || (match.operatorId ?? ''),
              state: match.state ?? 'offline',
            };
          })
          .filter((o): o is AssignableOperator => o !== null)
          .sort((a, b) => a.displayName.localeCompare(b.displayName));

        if (alive) setOperators(joined);
      } catch {
        // ⓘ An empty list, not an error banner. This is a CONVENIENCE read: the field still shows who
        // holds the ticket and «take it» still works, so a failed staff read must not degrade the
        // ticket window. The server refuses any assignment this list would have got wrong anyway.
        if (alive) setOperators([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [dataAccess, may]);

  return { operators, loading };
}
