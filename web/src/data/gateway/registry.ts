import type { ResourceName } from '../types';

/**
 * T004 — the route registry (feature 019, data-model §1).
 *
 * ── This file is DATA. The transport is the only thing that reads it, and it reads rows ─────────
 * The operator's constraint for this feature was: later work must ADD to it, never rewrite it.
 * That is only true if adding a resource is adding a row — so anything the transport would
 * otherwise have to know per-resource lives here as a field. If a new resource seems to need a
 * conditional in `gateway-data-access.ts`, the row shape is missing a field: add the field, not the
 * branch. `registry.structure.test.ts` enforces that, the same way the 011 permission / 014
 * automation / 015 audit / 016 upload / 017 export catalogues are enforced.
 *
 * ── Why `params` is an explicit allow-list and not `{...query.filters}` ─────────────────────────
 * The two routes consumed here DISAGREE about an unrecognised query parameter, measured 2026-07-29:
 *
 *   /players       → REFUSES it with a 400 naming the key   (services/gateway/src/players/wire.ts)
 *   /conversations → SILENTLY DROPS it (fixed destructured query)
 *
 * A generic serialiser is therefore not a shortcut but a defect: against `/players` it produces a
 * loud error, and against `/conversations` it produces a CONFIDENT WRONG ANSWER — the filter the
 * caller believed in is discarded and the result set silently widens. Feature 017's live run found
 * that exact shape one layer deeper. The client enforces the stricter rule for both.
 */

/** Which of the interface's five operations exist for a resource. */
export type Operation = 'list' | 'get' | 'create' | 'update' | 'remove';

export interface RouteRow {
  /** The name screens use. Unique across the registry. */
  readonly resource: ResourceName;
  /** Collection path under the same-origin API prefix. No host, no query. */
  readonly path: string;
  /** Key of the array in a list response. Differs per resource — there is no uniform `items`. */
  readonly collection: string;
  /** Accepted filters: the caller's key → the wire name. Anything else is refused client-side. */
  readonly params: Readonly<Record<string, string>>;
  /** Subset of `params` whose absence is a client-side failure. */
  readonly required: readonly string[];
  /** This route's paging parameter names. */
  readonly pageSizeParam: string;
  readonly pageTokenParam: string;
  /** Operations that exist. Anything absent fails loudly rather than silently doing nothing. */
  readonly ops: readonly Operation[];
}

/**
 * The whole registry. Two rows — read paths only; writes arrive with the page that needs them.
 *
 * `sort` is deliberately absent from every row: no consumed route accepts one, and quietly returning
 * an unsorted list would be a lie the caller cannot see.
 */
export const ROUTE_REGISTRY: readonly RouteRow[] = [
  {
    resource: 'conversations',
    path: '/conversations',
    collection: 'conversations',
    params: {
      status: 'status',
      priority: 'priority',
      assigneeOperatorId: 'assigneeOperatorId',
      playerId: 'playerId',
      brandId: 'brandId',
      slaOutcome: 'slaOutcome',
    },
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list', 'get'],
  },
  {
    resource: 'players',
    path: '/players',
    collection: 'players',
    // `brandId` is the ONLY accepted filter and it is REQUIRED: an unfiltered read would be "every
    // customer in the account", which is the anti-pitching failure itself rather than a wider query.
    params: { brandId: 'brandId' },
    required: ['brandId'],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list', 'get'],
  },
] as const;

/** Look up a row. An unknown resource is a programming error, surfaced as one. */
export function rowFor(resource: ResourceName): RouteRow {
  const row = ROUTE_REGISTRY.find((r) => r.resource === resource);
  if (!row) throw new Error(`no route registered for resource "${resource}"`);
  return row;
}
