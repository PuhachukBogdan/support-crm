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
  /**
   * Collection path under the same-origin API prefix. No host, no query.
   *
   * W7: may carry the `{within}` placeholder — the resource lives under an INSTANCE of another one
   * (`/conversations/{within}/thread`). The instance id arrives per call (`Query.within` for reads,
   * the `within` argument for writes), is REQUIRED, and is URL-encoded on substitution. A row
   * without the placeholder refuses a `within` — passing one is a programming error, not a request.
   */
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
  /**
   * W6: a SINGLETON has one instance per caller and its path names it whole — `get` takes no id and
   * appends nothing. `/me/operator` is the first: the subject is the session, so an id would be a
   * place to name somebody else, which is exactly what the server's route refuses to have.
   *
   * W7 extends the same rule to writes: a singleton's `update`/`remove` also take id `''` and
   * append nothing. Combined with `{within}` this models a child singleton — the ONE status of a
   * conversation lives at `/conversations/{within}/status`, and there is no status id to name.
   */
  readonly singleton?: true;
  /**
   * W7: non-default write verbs. Defaults — `create` POST · `update` PATCH · `remove` DELETE —
   * cover every row that does not say otherwise; the only declared exception so far is PUT, which
   * the gateway uses where the write is an idempotent *placement* (assignee, label attach) rather
   * than a partial edit. A field, not a branch: the transport reads it like everything else.
   */
  readonly verbs?: { readonly update?: 'PATCH' | 'PUT' };
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
      // W6 (R38): the rail's buckets — comma-separated CATEGORIES («Ждут» is pending,on_hold), never
      // status keys. The server resolves them against the account's own catalogue and REFUSES an
      // unknown entry rather than widening.
      statusCategories: 'statusCategories',
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
  /**
   * ⭐ W6 — the account's own status catalogue (`GET /conversations/statuses`, feature 032). The
   * toolbar's Status filter derives its OPTIONS from this, per bucket, so an account that renames or
   * retires a status never leaves the screen offering a word the server would refuse — the exact
   * defect class the `resolved` bucket shipped once (see `buckets.ts`).
   *
   * ⓘ The route reads no query at all, so the pagination params `list()` always sends are inert
   * there — harmless by the same one-directional rule the compose guard states: a parameter nobody
   * reads is noise, a parameter silently DROPPED would be a defect.
   */
  {
    resource: 'conversation-statuses',
    path: '/conversations/statuses',
    collection: 'statuses',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  /**
   * ⭐ W6 — "which operator am I?" (`GET /me/operator`, roadmap 5.11). A SINGLETON: the subject is
   * the session, there is no id to pass and no way to name anyone else — mirrored from the server
   * route, whose spec asserts the same absence structurally.
   */
  {
    resource: 'me-operator',
    path: '/me/operator',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['get'],
    singleton: true,
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
  /**
   * ⭐ W7 — the ticket window's rows (roadmap 9.3). The window is the first WRITING screen, so these
   * are the first rows with write ops and the first children (`{within}` = the conversation id).
   *
   * `conversation-thread` — the staff projection by default; `projection` is declared so a future
   * customer-facing surface can ask for the narrower read EXPLICITLY, never by accident.
   */
  {
    resource: 'conversation-thread',
    path: '/conversations/{within}/thread',
    collection: 'messages',
    params: { projection: 'projection' },
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    // POST body: { kind?: 'reply'|'note', body?, mentions?, uploadIds? }. ⚠️ An unknown kind is the
    // server's 400, never a default — the coercion that once published an internal note (SEC-13).
    resource: 'conversation-messages',
    path: '/conversations/{within}/messages',
    collection: 'messages',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create'],
  },
  {
    // The account's label set. Creating labels is also `crm.labels.manage` — same key as reading,
    // so a control that can see the list can offer "new tag" without a second permission story.
    resource: 'labels',
    path: '/labels',
    collection: 'labels',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list', 'create'],
  },
  {
    // Attach = PUT /conversations/{id}/labels/{labelId} (idempotent placement), detach = DELETE
    // same path. `update` with an empty patch IS the attach — the link has no body to carry.
    resource: 'conversation-labels',
    path: '/conversations/{within}/labels',
    collection: 'labels',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    verbs: { update: 'PUT' },
    ops: ['list', 'update', 'remove'],
  },
  {
    // A child SINGLETON: the one status of a conversation. `update('conversation-status', '',
    // {status}, conversationId)` — the body carries a status KEY from the account's own catalogue;
    // the server validates it there, the client never invents one.
    resource: 'conversation-status',
    path: '/conversations/{within}/status',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['update'],
  },
  {
    // Assignee: PUT places (idempotent), DELETE unassigns — `remove` on the singleton, no id.
    // «take it» is exactly `update` with the caller's own operator id from `/me/operator`.
    resource: 'conversation-assignee',
    path: '/conversations/{within}/assignee',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    verbs: { update: 'PUT' },
    ops: ['update', 'remove'],
  },
  {
    // The one byte-accepting route in the product, purpose-scoped (`message_attachment`: 10 MB,
    // png/jpeg/webp/gif/pdf by CONTENT). The caller sends a FormData; the port passes it through.
    resource: 'message-attachment-uploads',
    path: '/uploads/message_attachment',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create'],
  },
] as const;

/** Look up a row. An unknown resource is a programming error, surfaced as one. */
export function rowFor(resource: ResourceName): RouteRow {
  const row = ROUTE_REGISTRY.find((r) => r.resource === resource);
  if (!row) throw new Error(`no route registered for resource "${resource}"`);
  return row;
}
