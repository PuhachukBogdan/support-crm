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
   * cover every row that does not say otherwise. PUT marks an idempotent *placement* (assignee,
   * label attach); W8 adds POST for an *action on an item* (`POST /conversations/{id}/macros/{id}`
   * — applying is neither an edit nor idempotent, and the verb is the gateway's, declared here so
   * the transport stays verb-agnostic). A field, not a branch.
   */
  readonly verbs?: { readonly update?: 'PATCH' | 'PUT' | 'POST' };
  /**
   * W14: a fixed segment AFTER the item id — `/admin/access/users/{id}/role`. The gateway names
   * some writes by what they change rather than by the resource they change it on, and the
   * transport must be able to express that without learning a resource's name. A field, not a
   * branch: `itemPath` appends it and nothing else knows it exists.
   */
  readonly itemSuffix?: string;
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
      // ⭐ W10 (roadmap 4.19): the "he OPENED it" leg of the agent's own rail — a ConversationReadMark
      // written when someone opens the ticket. An operator ID rather than a `me` flag, because a
      // supervisor may read an agent's rail; the window sends its own id (from `/me/operator`).
      openedByOperatorId: 'openedByOperatorId',
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
    // `brandId` is REQUIRED: an unfiltered read would be "every customer in the account", which is
    // the anti-pitching failure itself rather than a wider query.
    // ⭐ W11 adds `playerIdPrefix` — the directory's search, by the PLATFORM ID the agent already
    // has. ⛔ There is deliberately no `email`/`phone` key and there must never be one: searching by
    // a contact is the inversion, and it lives only under a conversation (ADR 0044 §4).
    params: { brandId: 'brandId', playerIdPrefix: 'playerIdPrefix' },
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
    // ⭐ W16 (subpoint 3.11) — the registry: every label with its usage count. A separate row from
    // `labels` because it is a separate read: the pickers must not pay for the aggregate.
    resource: 'label-usage',
    path: '/labels/usage',
    collection: 'labels',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  /**
   * ⭐ W16 (subpoint 3.12) — the audit log, read over feature 015's federated `GET /audit`
   * (`platform.audit.view`). The filters are the route's own closed set; `action`/`actionClass`
   * are mutually exclusive and the SERVER refuses the pair — the client sends what the screen
   * picked and does not re-implement that rule.
   */
  {
    resource: 'audit-entries',
    path: '/audit',
    collection: 'entries',
    params: {
      action: 'action',
      actionClass: 'actionClass',
      actorUserId: 'actorUserId',
      targetRef: 'targetRef',
      from: 'from',
      to: 'to',
    },
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
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
  /**
   * ⭐ 2026-08-10 — the three remaining editable properties of a ticket, each a child SINGLETON like
   * the status above (operator: «все остальные поля… мы должны иметь возможность редактировать»).
   *
   * All three routes existed on the gateway before this; only `priority` needed building. They were
   * absent HERE, which is why the left column rendered them as text: a screen can only reach what the
   * registry declares, and an undeclared route is indistinguishable from an unbuilt one.
   */
  {
    // The human title (feature 023). Refused when blank or over 120 chars — by the SERVER, so the
    // screen never has to hold a second copy of the rule.
    resource: 'conversation-subject',
    path: '/conversations/{within}/subject',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['update'],
  },
  {
    // ⚠️ `''` is a real value here — "no priority", the state a ticket is created in. Anything that
    // treats the body as falsy-means-absent breaks exactly the clear case.
    resource: 'conversation-priority',
    path: '/conversations/{within}/priority',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['update'],
  },
  {
    // Brand (feature 032 — R22). Its own permission server-side (`crm.conversation.set_brand`): an
    // agent may not change it, a supervisor corrects it, and the correction is audited.
    resource: 'conversation-brand',
    path: '/conversations/{within}/brand',
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
  /**
   * ⭐ W8 — the composer's pickers (roadmap 4.5). Both lists ride `crm.macros.use` since W8 dropped
   * the read gate (the picker is for agents; authoring stays `crm.templates.manage` and has no row
   * here — the admin surface is a later block's).
   */
  {
    resource: 'macros',
    path: '/macros',
    collection: 'macros',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    resource: 'canned-responses',
    path: '/canned-responses',
    collection: 'canned',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    // Applying a macro: POST to the macro's path under the conversation — an ACTION on an item.
    // The service re-checks the permission of every bundled action, all-or-nothing (FR-008).
    resource: 'conversation-macros',
    path: '/conversations/{within}/macros',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    verbs: { update: 'POST' },
    ops: ['update'],
  },
  /**
   * ⭐ W14 (roadmap 3.8) — the account's PEOPLE, and the mutations that need one.
   *
   * ⚠️ `staff` is a READ of `/admin/access/users`, gated `users.list.view`. Its sibling
   * `staff-role` writes through `/admin/access/users/:id/role`, which is **super-admin only** — two
   * different authorization models on one screen, and the screen must not pretend otherwise: the
   * list renders for a teamlead, the role control does not.
   */
  {
    resource: 'staff',
    path: '/admin/access/users',
    collection: 'users',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    // PUT /admin/access/users/:id/role — body `{roleKey, op}`. A placement, not a partial edit.
    resource: 'staff-role',
    path: '/admin/access/users',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    verbs: { update: 'PUT' },
    itemSuffix: 'role',
    ops: ['update'],
  },
  {
    // ⭐ W14 (roadmap 3.8, the block's remainder) — POST /auth/invites, the feature-010 engine's
    // edge, untouched since Phase 3. Body {email, role}; the INVITER is the session (claims), never
    // a field. The email rides the body, so it can never land in a proxy's query log (SEC-26).
    // Write-only: reading invitations back is not a capability this screen has or needs — the
    // invited person appears in `staff` as status `invited`, which is the visible outcome.
    resource: 'invites',
    path: '/auth/invites',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create'],
  },
  /**
   * ⭐ W14 (roadmap 3.9) — desks and their membership (the feature-024 engine, unchanged).
   * `groups` lists and creates; `group-members` adds/removes by user id under a group.
   */
  {
    resource: 'groups',
    path: '/groups',
    collection: 'groups',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list', 'create'],
  },
  {
    resource: 'group-members',
    path: '/groups/{within}/members',
    collection: 'userIds',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    verbs: { update: 'PUT' },
    ops: ['list', 'update', 'remove'],
  },
  /**
   * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the account's configured channels, and the one
   * write the admin screen has: a brand's mail address.
   *
   * ⚠️ `admin-channels` reads keys and addresses — OUR configuration, not customer data — and no
   * secret can ride it: the Channel table holds none (the secret lives in deployment config,
   * looked up by the key this list shows). The write is a PUT placement keyed by BRAND: a brand
   * with no email channel gets one, a brand with one gets its address changed.
   */
  {
    resource: 'admin-channels',
    path: '/admin/channels',
    collection: 'channels',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    // PUT /admin/channels/email/{brandId} — body {address}. The id is the BRAND, not the channel:
    // the server owns the row's identity, the screen only knows which brand's mail it is placing.
    resource: 'admin-email-channel',
    path: '/admin/channels/email',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    verbs: { update: 'PUT' },
    ops: ['update'],
  },
  /**
   * ⭐ W15a (subpoint 3.14) — the status authoring WRITES. The read has no row here on purpose: the
   * screen reads the catalogue through `conversation-statuses` above (feature 032's route already
   * returns retired rows), so there is exactly one projection to keep honest. `create` POSTs the
   * three fields; `update` PATCHes by KEY (names / category / active — sending `active` is what
   * makes it a retire/restore, the edge translates absence into "unchanged").
   */
  {
    resource: 'admin-statuses',
    path: '/admin/statuses',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create', 'update'],
  },
  /**
   * ⭐ W18 (subpoints 5.2/5.3) — the operator's OWN UI preferences (`/me/ui-preferences`, feature
   * 021). A SINGLETON like `/me/operator`: the subject is the session, an id would be a place to
   * name somebody else. The PATCH body is `{values: {theme_mode: 'dark'}}` — keys from the closed
   * catalogue in `libs/common/src/preferences/ui-preferences.ts`, validated by the owning service.
   */
  {
    resource: 'ui-preferences',
    path: '/me/ui-preferences',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['get', 'update'],
  },
  /**
   * ⭐ W19 (subpoints 5.4/5.5) — the profile writes and the presence singleton. `avatar-uploads`
   * POSTs the multipart bytes under 016's `avatar` purpose (2 MB, png/jpeg/webp by magic bytes, an
   * always-made 256px thumb); `my-avatar` PUTs the returned upload id onto MY profile; `my-presence`
   * reads and places MY state (`online | transfers_only | away | offline` — the closed set the
   * server validates). All three are self-scoped: no id can name anyone else.
   */
  {
    resource: 'avatar-uploads',
    path: '/uploads/avatar',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create'],
  },
  {
    resource: 'my-avatar',
    path: '/me/operator/avatar',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    verbs: { update: 'PUT' },
    ops: ['update'],
  },
  {
    resource: 'my-presence',
    path: '/presence/me',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    verbs: { update: 'PUT' },
    ops: ['get', 'update'],
  },
  /**
   * ⭐ W20 (roadmap 11.1 minimum) — the dashboard's one read: aggregates straight from the journal
   * (`analytics.dashboard.view`). A SINGLETON with a declared filter: `days` bounds the volume
   * series (server-capped at 90).
   */
  {
    resource: 'analytics-snapshot',
    path: '/analytics/snapshot',
    collection: '',
    params: { days: 'days' },
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['get'],
  },
  {
    // W20: the assignee axis resolves ids to NAMES through the read the inbox already owns
    // (`GET /operators/:id`, `crm.inbox.view`) — never a second staff surface.
    resource: 'operators',
    path: '/operators',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['get'],
  },
  /**
   * ⭐ 2026-08-10 — the ticket window's Assignee chooser (operator: *«не вижу возможности менять поля
   * типа бренд, ассайни»*). AUTH user ids → operator ids + presence, under
   * `crm.conversation.assign`.
   *
   * ⚠️ **`authUserIds` is REQUIRED and the server refuses an absent one with a 400** — there is no
   * "all operators" question in the contract. The browser gets the ids (and the NAMES) from the
   * staff list and asks this only to translate them; a screen that hoped for a default here would be
   * asking for a list nothing promised to return.
   */
  {
    resource: 'assignable-operators',
    path: '/operators',
    collection: 'operators',
    params: { authUserIds: 'authUserIds' },
    required: ['authUserIds'],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['get'],
  },
  /**
   * ⭐ W17 (subpoint 4.4) — the caller's OWN portfolio (`GET /me/players`, feature 026's read). The
   * subject is the session — there is nobody else this path can name, which is what makes it safe
   * for every role: a non-AM simply owns an empty portfolio.
   */
  {
    resource: 'my-players',
    path: '/me/players',
    collection: 'players',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  {
    // ⭐ W17 (subpoint 4.6) — write first: POST creates the conversation AND posts its first mail.
    // The server owns every rule (portfolio, address, channel, status) — this row only names the path.
    resource: 'initiate-email',
    path: '/conversations/initiate-email',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['create'],
  },
  /**
   * ⭐ W11 (roadmap 9.17) — the account's brands. It exists because every player read REQUIRES a
   * brand and the browser had no way to learn which ones there are. ⚠️ A brand is a FILTER, not a
   * wall (ADR 0038 §1): this list decides nothing about access, and no screen may treat it as if
   * it did.
   */
  {
    resource: 'brands',
    path: '/brands',
    collection: 'brands',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    ops: ['list'],
  },
  /**
   * ⭐ W10 (roadmap 4.13) — the player's contact history, for the card in the right rail. A CHILD of
   * the player: `/players/{within}/contact-summary`. `brandId` is REQUIRED, exactly as it is on the
   * player read itself — the same platform id under two brands is two people (the 07-29 repair), and
   * the server answers INVALID_ARGUMENT without it rather than guessing.
   *
   * ⓘ A contact-VALUE can never arrive through this: a contract test forbids phone/email/handle
   * fields on `ContactSummary` outright. What it carries is counts and timestamps.
   */
  {
    resource: 'player-contact-summary',
    path: '/players/{within}/contact-summary',
    collection: '',
    params: { brandId: 'brandId' },
    required: ['brandId'],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['get'],
  },
  /**
   * ⭐ W9 / spec 035 (ADR 0044 §4) — the contact lookup. A CHILD SINGLETON with a POST verb: the
   * searched value rides the body (never a query a proxy would log), and the route exists only
   * under a conversation — there is deliberately no account-level lookup row here, because a
   * standalone one would BE the "player database with a search box" the ADR forbids.
   */
  {
    resource: 'conversation-contact-lookup',
    path: '/conversations/{within}/contact-lookup',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    verbs: { update: 'POST' },
    ops: ['update'],
  },
  {
    // The warning, READ before the detach it warns about (0044 §5 requires the person be told
    // first). Same harvest the detach returns, so the dialog and the outcome cannot disagree.
    resource: 'conversation-detach-preview',
    path: '/conversations/{within}/player/detach-preview',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    ops: ['get'],
  },
  {
    // The identity pair (0044 §5): PUT places, DELETE detaches — and DELETE's RESPONSE repeats the
    // warning as the outcome, which is why `remove` here is read for its body.
    resource: 'conversation-player',
    path: '/conversations/{within}/player',
    collection: '',
    params: {},
    required: [],
    pageSizeParam: 'pageSize',
    pageTokenParam: 'pageToken',
    singleton: true,
    verbs: { update: 'PUT' },
    ops: ['update', 'remove'],
  },
] as const;

/** Look up a row. An unknown resource is a programming error, surfaced as one. */
export function rowFor(resource: ResourceName): RouteRow {
  const row = ROUTE_REGISTRY.find((r) => r.resource === resource);
  if (!row) throw new Error(`no route registered for resource "${resource}"`);
  return row;
}
