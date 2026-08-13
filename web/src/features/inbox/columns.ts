import type { ColumnTier } from '@/components/composites/data-table';
import { PRIORITIES } from '@/data/priorities';
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
   * *«может их прям в эту плашку и впихнуть»* — and reconfirmed the hard way on 2026-08-06 after W6's
   * first cut replaced the funnels with a toolbar: *«Мы зачем по-твоему их добавляли? Верни. И не
   * делай так больше»*. The 08-04 snapshot caption «Отличная вещь — фильтры. Оставим» praised having
   * FILTERS, not Zendesk's placement of them; reading it as a layout instruction was my mistake, twice
   * recorded so it is not made a third time).
   *
   * ⛔ **Declared only where the filter genuinely IS this column.** Static options live here; the
   * status column's options are the ACCOUNT'S OWN catalogue (narrowed to the bucket's categories) and
   * are resolved at render — a hardcoded status list is the retired-word defect waiting to recur.
   */
  readonly filter?: {
    readonly key: FilterKey;
    /** Static options, or 'catalogue' — resolved by the screen from `use-statuses` per bucket. */
    readonly options: readonly string[] | 'catalogue';
  };
}

/** The keys the transient filter state accepts. Kept structural so a renamed filter breaks the build. */
export type FilterKey = 'status' | 'channel' | 'priority';

/**
 * ⭐ **Corrected by feature 033 (2026-08-05): `'chat'` is gone.** The arrival channel is the closed
 * vocabulary `api | email | messenger`; `messenger` is deliberately absent HERE because no messenger
 * transport is connected in the MVP — an option that can only ever match nothing teaches an agent the
 * queue is empty (the standing empty-filter rule). It arrives with the transport (6.2/6.3).
 *
 * ⛔ **No "no channel" option:** ~1 in 6 rows carry none, the wire cannot express "unset" as a value,
 * and those rows stay reachable by NOT filtering (FR-011a).
 */
const CHANNELS = ['api', 'email'] as const;

/**
 * The priority vocabulary the product writes (`priorityWrite`, feature 031).
 *
 * ⚠️⚠️ **This list used to be spelled here, and it was WRONG.** It read
 * `['low', 'normal', 'high', 'urgent']` against a service that has always known three — under a
 * comment claiming that a closed set "cannot rot the way the status list did". It rotted in the one
 * way a closed set can: by containing a word the owning service never had. Filtering by `urgent`
 * matched nothing, forever, and an empty list is exactly what a working filter shows when there is
 * genuinely no urgent work — a wrong answer with no symptom, found only when the ticket window's
 * priority EDITOR forced the two lists into the same sentence (2026-08-10).
 *
 * It is now imported from one place (see the import at the top of this file), cross-checked against
 * the service by `priorities-match-the-service.test.ts`.
 */

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
    filter: { key: 'status', options: 'catalogue' },
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
  {
    id: 'priority',
    header: 'Priority',
    tier: 'contextual',
    width: 96,
    // 2026-08-06: the operator counts priority among the funnels the screen owes him («по статусам,
    // каналам и приоритетам»). The route has always accepted the parameter.
    filter: { key: 'priority', options: PRIORITIES },
  },
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
