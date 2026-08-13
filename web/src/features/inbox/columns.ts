import type { ColumnTier } from '@/components/composites/data-table';
import type { ConversationRow } from './types';

/**
 * The Inbox's column set and its PRIORITY order (feature 029, FR-004/FR-006).
 *
 * ── Why priority is data and not a media query ───────────────────────────────────────────────────
 * The operator's complaint about their current tool is specific and repeated: *«страница слишком
 * растянута»* — and cross-cutting conclusion **A** raises density from taste to a requirement. A
 * requirement has to be testable, and "looks dense" is not. A declared priority makes it an
 * assertion: *at 2560 px all default columns are present; at 1280 px exactly these are gone.*
 *
 * ⛔ **Horizontal scrolling is never the fallback** (FR-005/FR-006). When width runs out, the
 * lowest-priority columns are dropped and the rest truncate. A list that scrolls sideways hides the
 * status column behind a gesture nobody makes.
 *
 * ⚠️ **This file no longer decides what fits.** Tiers come from `ui-design/density-spec.md` §2 and the
 * composite sheds them (§7: S2 owns tiering, S4 declares tiers). The assertion the priority table used to
 * make — *at 2560 px all default columns are present; at 1280 px exactly these are gone* — is now made
 * against the composite, where it is true of every list rather than of this one.
 */
export interface InboxColumn {
  /** The row field this column reads. Keyed on the type so a renamed field breaks the build. */
  readonly id: keyof ConversationRow;
  /** The human label. ⚠️ Deliberately not derived from `id` — two of them must NOT match the field
   *  name: `lastActivityAt` shows as "Updated" (R7) and `playerId` as "Player" (R9). */
  readonly header: string;
  /**
   * One of `density-spec.md` §2's three tiers — **the only narrowing decision this screen makes.**
   *
   * ⚠️ It used to be a `priority` number 1–6 paired with a `columnsForWidth()` here, which is exactly
   * what §7 records as feature 029's violation: *"the screen hand-coding breakpoints and reimplementing
   * what S2 owns"*. The composite sheds `optional`, then `contextual` from the last declared backwards,
   * and never sheds `essential`.
   */
  readonly tier: ColumnTier;
  /** Width this column wants, in px — TanStack's own `size`, forwarded by the composite. */
  readonly width: number;
  /**
   * ⭐ The two server orders this column can be sorted by — the triangles in Zendesk's header
   * (`screenshots/views_2.png`), which the operator asked for on the columns where "bigger to
   * smaller" means something.
   *
   * ⛔ **Present only where the SERVER can honour it.** A header arrow that reorders nothing is the
   * confidently-wrong control this project has spent days removing — and on a sort it is invisible,
   * because a list is still a list in the wrong order. Today the route declares exactly two orders,
   * both on `updated_at`; `Requested` and `Priority` get their arrows when the server gets the orders
   * (roadmap 9.2b, step 2 — priority needs a rank column, not an alphabetical sort of
   * "high/low/normal/urgent").
   */
  readonly sort?: { readonly asc: string; readonly desc: string };
  /**
   * ⭐ The filter this column owns, opened from a **funnel in its own header** (operator, 2026-08-03:
   * *«может их прям в эту плашку и впихнуть»*).
   *
   * This is the sanctioned kind of change: first the Zendesk copy, then our improvement on top. Zendesk
   * keeps a filter bar above the list; a column that carries both its sort and its filter puts the
   * control where the thing it narrows already is.
   *
   * ⛔ **Declared only where the filter genuinely IS this column** — otherwise the header would host a
   * narrowing that has nothing to do with it, which is worse than a toolbar.
   */
  readonly filter?: {
    readonly key: FilterKey;
    readonly options: readonly string[];
  };
}

/** The keys the transient filter state accepts. Kept structural so a renamed filter breaks the build. */
type FilterKey = 'status' | 'channel';

/**
 * ⚠️ Statuses are DATA, not code (cross-cutting conclusion D — custom statuses exist). These are the
 * ones the wire enum defines **and that something actually produces**; when custom statuses land they
 * come from the server and this constant goes away.
 *
 * ⛔ **`snoozed` was here and is removed.** The operator hit it and asked what it was for — the honest
 * answer is *nothing*: it exists in the schema comment and both wire maps, **no code path ever sets it**,
 * and the stand has zero such rows. It was in this list only because the enum was copied instead of
 * asking what fills it. A filter option that can only ever return an empty list teaches an agent that
 * the queue is empty when it is not.
 *
 * ⛔ **`resolved` is also gone**, on the operator's instruction: it has its own bucket in the rail, and
 * *«не вижу смысла отдельно в статус фильтре resolved выделять, если они будут в отдельной вкладке»*.
 * Two routes to the same set is how a bucket and a filter end up disagreeing.
 */
const STATUSES = ['open', 'pending'] as const;

/**
 * ⭐ **Corrected by feature 033 (2026-08-05): `'chat'` is gone.** The 033 migration typed the arrival
 * channel into the closed vocabulary `api | email | messenger` and folded `chat` into `api` — the widget
 * chat *is* the API channel (roadmap 6.1). Left in this list it would be a filter option matching zero
 * rows, which reads to an agent as "there are no widget tickets" rather than "that word is retired".
 *
 * ⚠️ **This paragraph replaces one claiming the list is deliberately NOT a closed catalogue.** That was
 * true when a channel was free text; it stopped being true when three subsystems began standing on the
 * column (SLA per channel, this filter, the analytics split). The values are now a catalogue in
 * `libs/common/src/channels/kinds.ts`, and `messenger` is deliberately absent HERE rather than absent
 * there: the kind exists so the vocabulary is complete, but no messenger is connected in the MVP, so
 * offering it would be the same empty-filter mistake in a new place. It arrives with the transport.
 *
 * ⛔ **There is no "no channel" option, and that is a real limitation worth stating.** About one in six
 * conversations carry no channel; the wire cannot express "unset" as a filter value (an empty string
 * means "no filter"). Those rows stay reachable by not filtering — so the filter narrows, and clearing
 * it is how you get back to everything (FR-011a).
 */
const CHANNELS = ['api', 'email'] as const;

/**
 * ⭐ **Order copied from Zendesk** (`ui-design/screenshots/views_1.png`, 2026-08-03):
 * `Ticket status · Requested · Channel · Requester · Subject · Priority · Assignee`.
 *
 * ⚠️ Ours put **Subject first**; Zendesk leads with the **status** and puts the subject fifth. The
 * operator's rule is now to reproduce the visual and adjust afterwards, so the order follows the
 * screenshot rather than our earlier judgement.
 *
 * Two deliberate differences, both because the product cannot do otherwise (recorded in §2a of the
 * reference): **Requester → "Player"** (we store no customer name at any tier — GR8, roadmap 5.4),
 * and **no Satisfaction column** (no ratings exist — roadmap 10.4).
 */
export const INBOX_COLUMNS: readonly InboxColumn[] = [
  {
    id: 'status',
    header: 'Status',
    tier: 'essential',
    width: 96,
    // ⓘ No sort arrow: Zendesk shows none on Ticket status either — a status is a set, not a scale.
    filter: { key: 'status', options: STATUSES },
  },
  // "Requested" is the creation instant. §2 makes *time-since* essential and that is `Updated` below;
  // when the queue is narrow, which one still matters is the one that moved.
  { id: 'createdAt', header: 'Requested', tier: 'contextual', width: 120 },
  /**
   * ⚠️ "Player", NOT "Requester" — research R9. This product stores no customer name, email or phone
   * at any tier; identity lives in GR8 and arrives with roadmap 5.4. A column headed "Requester"
   * holding `9f3c-…` reads as a broken name. Headed "Player" holding a player id, it is simply true —
   * and it is the identifier agents paste into other tools all day (R34).
   */
  /**
   * ⚠️ "Updated", NOT "Last activity" — research R7. The value behind it is `updated_at`, which OUR
   * OWN relabelling, reassigning and resolving bump. Calling it activity would claim the customer did
   * something, and it would look right doing so. Real customer contact belongs to urgency (4.20).
   */
  {
    id: 'lastActivityAt',
    header: 'Updated',
    // §2's "time-since" — essential, and the one column carrying a sort the server honours.
    tier: 'essential',
    width: 120,
    sort: { asc: 'updated_asc', desc: 'updated_desc' },
  },
  {
    id: 'channel',
    header: 'Channel',
    tier: 'contextual',
    width: 100,
    filter: { key: 'channel', options: CHANNELS },
  },
  { id: 'playerId', header: 'Player', tier: 'essential', width: 140 },
  // The reason feature 023 exists: a queue you can scan. Never shed; truncates instead.
  { id: 'subject', header: 'Subject', tier: 'essential', width: 220 },
  { id: 'priority', header: 'Priority', tier: 'contextual', width: 96 },
  { id: 'assigneeOperatorId', header: 'Assignee', tier: 'contextual', width: 140 },
  // Displayed, never filterable: ADR 0027 reserved it and nothing populates it yet except the seeded
  // rows, so a filter would offer options matching nothing.
  // ⭐ **`optional` ⇒ off unless opted into** (§2), which is the state the density spec always asked for.
  // It rendered by default only because the screen had no way to express "optional" — the tier now does.
  { id: 'category', header: 'Category', tier: 'optional', width: 120 },
];

/**
 * ⛔ **`columnsForWidth()` is gone, deliberately.** It was this screen deciding what fits, from a width
 * it measured off `window.innerWidth` — a number the table never had, since the sidebar, the bucket rail
 * and every gap come out of it first. That is why columns were squeezed rather than shed at half screen.
 *
 * The decision now lives in `DataTable.columnsThatFit`, which measures **its own** box.
 */
