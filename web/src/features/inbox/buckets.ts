import type { InboxFilters } from './use-inbox-query';

/**
 * The buckets from Zendesk's Home column (`ui-design/screenshots/home.png`): *Your work → Tickets*,
 * *Shared work → CC'd, Following*, *Completed work → Last 30 days*.
 *
 * ⚠️ **Two of the three, on the operator's instruction (2026-08-03):** *«Оставь Your work и Completed
 * пока»*. **Shared work is not built** — its contents are *CC'd* and *Following*, and neither concept
 * exists in this product: nothing subscribes a person to someone else's conversation. A bucket that
 * could only ever be empty is an affordance for a feature nobody has, which is the same defect as a
 * views placeholder.
 *
 * ⓘ These are **not** saved views (roadmap 9.2a). A bucket is a fixed, built-in narrowing of the
 * agent's own queue; a view is a stored object an admin grants. Keeping the words apart matters —
 * they land in the same column and would otherwise be assumed to be one mechanism.
 */
export type BucketId = 'yours' | 'completed' | 'archive';

export interface Bucket {
  readonly id: BucketId;
  /** The group heading above it in the rail, as Zendesk arranges them. */
  readonly group: string;
  readonly label: string;
  /**
   * What the bucket narrows to, merged over whatever the person has filtered.
   *
   * ⚠️ A bucket sets `status`, so choosing one while a *status* filter is active would give two
   * answers to one question. The screen resolves that by clearing the filter the bucket owns — see
   * `use-inbox-query`.
   */
  readonly filters: InboxFilters;
  /**
   * Shown, but not yet selectable — the shape is visible so it is not forgotten, and it says so.
   * ⚠️ Must never be silently inert: see `coming-soon.tsx` for why a labelled placeholder is allowed
   * where a plain disabled one is not.
   */
  readonly comingSoon?: true;
}

export const BUCKETS: readonly Bucket[] = [
  // Zendesk's "Your work → Tickets": everything on the agent's plate, whatever its state.
  { id: 'yours', group: 'Your work', label: 'Tickets', filters: {} },
  /**
   * Zendesk's "Completed work → Last 30 days". Ours narrows by status rather than by date: we have a
   * `resolved` status and no 30-day window, and inventing the window would need a date filter the
   * route does not accept. ⇒ Labelled for what it actually shows.
   */
  { id: 'completed', group: 'Completed work', label: 'Resolved', filters: { status: 'resolved' } },
  /**
   * ⭐ The **Archive** the operator asked for (2026-08-03): every manager's tickets, with Zendesk's
   * view list inside it — *«не кнопка архив, а именно категория архив»*.
   *
   * ⛔ **A placeholder, deliberately.** Three things it needs do not exist:
   *   • the saved **views** it is supposed to contain (roadmap 9.2a — no entity, no grant, no counts);
   *   • the **date-range** filter it is the natural home for (no such server filter);
   *   • ⚠️ and a **permission**. "All managers' tickets" is a bulk-read surface over customer data —
   *     precisely what SEC-AP2 exists to bound. It is invisible today only because the Inbox itself
   *     is not yet scoped to one agent; the moment it is, this becomes a right, not a tab.
   */
  { id: 'archive', group: 'Archive', label: 'All tickets', filters: {}, comingSoon: true },
];

export const DEFAULT_BUCKET: BucketId = 'yours';

export function bucketById(id: BucketId): Bucket {
  const found = BUCKETS.find((b) => b.id === id);
  if (!found) throw new Error(`no such bucket: ${id}`);
  return found;
}
