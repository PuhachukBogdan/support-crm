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
 * Lower `priority` = kept longer. 1 is never dropped.
 */
export interface InboxColumn {
  /** The row field this column reads. Keyed on the type so a renamed field breaks the build. */
  readonly id: keyof ConversationRow;
  /** The human label. ⚠️ Deliberately not derived from `id` — two of them must NOT match the field
   *  name: `lastActivityAt` shows as "Updated" (R7) and `playerId` as "Player" (R9). */
  readonly header: string;
  /** 1 = never dropped; larger numbers are shed first as the viewport narrows. */
  readonly priority: number;
  /** Minimum width in px this column needs to be worth showing at all. */
  readonly minWidth: number;
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
}

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
  { id: 'status', header: 'Status', priority: 1, minWidth: 96 },
  { id: 'createdAt', header: 'Requested', priority: 3, minWidth: 120 },
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
    priority: 2,
    minWidth: 120,
    sort: { asc: 'updated_asc', desc: 'updated_desc' },
  },
  { id: 'channel', header: 'Channel', priority: 4, minWidth: 100 },
  { id: 'playerId', header: 'Player', priority: 2, minWidth: 140 },
  // The reason feature 023 exists: a queue you can scan. Never dropped; truncates instead.
  { id: 'subject', header: 'Subject', priority: 1, minWidth: 220 },
  { id: 'priority', header: 'Priority', priority: 3, minWidth: 96 },
  { id: 'assigneeOperatorId', header: 'Assignee', priority: 5, minWidth: 140 },
  // Displayed, never filterable: ADR 0027 reserved it and nothing populates it yet except the seeded
  // rows, so a filter would offer options matching nothing.
  // ⓘ The density spec puts category in the *optional* tier (off by default). Left visible until the
  // tiering moves into the composite, where "optional" becomes expressible — roadmap 9.2b.
  { id: 'category', header: 'Category', priority: 6, minWidth: 120 },
];

/**
 * The columns that fit `width`, in declared order.
 *
 * Drops the lowest-priority columns until the rest fit. Priority-1 columns are never dropped — at an
 * absurdly narrow width they truncate instead, because a list with no subject is not a list.
 */
export function columnsForWidth(width: number): readonly InboxColumn[] {
  const byPriority = [...INBOX_COLUMNS].sort((a, b) => b.priority - a.priority);
  const dropped = new Set<InboxColumn['id']>();

  const total = () =>
    INBOX_COLUMNS.filter((c) => !dropped.has(c.id)).reduce((sum, c) => sum + c.minWidth, 0);

  for (const candidate of byPriority) {
    if (total() <= width) break;
    if (candidate.priority === 1) continue;
    dropped.add(candidate.id);
  }

  return INBOX_COLUMNS.filter((c) => !dropped.has(c.id));
}
