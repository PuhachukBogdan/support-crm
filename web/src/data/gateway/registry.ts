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
  /**
   * Feature 029 — the ORDER vocabulary, when the route has one.
   *
   * ⚠️ An order is not a filter and not a generic sort. `Query.sort` (an arbitrary `{field, dir}[]`)
   * remains refused by the transport for every route, because no route accepts one; what
   * `/conversations` accepts is a choice between NAMED orders the server implements. Modelling that as
   * a free-form sort would let a screen ask for `subject asc` and be told nothing until it silently
   * came back unordered.
   *
   * A row with no `orders` accepts no order at all, and asking for one is refused client-side.
   * ⇒ The sort control derives its options from this array, so an order the server cannot honour is
   * unrenderable rather than merely untested (FR-012a).
   */
  readonly orderParam?: string;
  readonly orders?: readonly string[];
  /** Operations that exist. Anything absent fails loudly rather than silently doing nothing. */
  readonly ops: readonly Operation[];
}

/**
 * The whole registry. Two rows — read paths only; writes arrive with the page that needs them.
 *
 * ── On sorting (amended by feature 029) ─────────────────────────────────────────────────────────
 * `sort` — an arbitrary `{field, dir}[]` — is still deliberately absent from every row, and the
 * transport still refuses it outright: no route accepts one, and quietly returning an unsorted list
 * would be a lie the caller cannot see.
 *
 * What changed is narrower: `/conversations` now accepts a choice between two NAMED orders, declared
 * as `orders` on its row. That is a closed vocabulary the server implements, not a field the caller
 * picks — so a screen cannot ask to sort by subject and be quietly ignored. The distinction is the
 * same one the export contract draws between a filter and a sequencing parameter.
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
      // Feature 029 (roadmap 9.2): the Inbox filters by arrival channel. ⚠️ Omitting it means "no
      // filter on channel", NOT "conversations with no channel" — ~1 in 6 rows have none and stay
      // reachable only because the parameter is absent.
      channel: 'channel',
    },
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    // The orders the server actually implements, and the whole list of them.
    // ⭐ Feature 031 (roadmap 4.19) adds `urgency_desc`. The list previously carried a note that there was
    // no urgency option because nothing computed urgency; the rank exists now, so the third option is
    // truthful. ⚠️ Still no `recommended`: nothing recommends anything, and this sorts by a stated key.
    orderParam: 'order',
    orders: ['updated_desc', 'updated_asc', 'urgency_desc'],
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
