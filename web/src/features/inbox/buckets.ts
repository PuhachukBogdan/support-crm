import type { InboxFilters } from './use-inbox-query';

/**
 * ⭐ **R38 (operator, 2026-08-05): the rail is FIVE BUTTONS ON CATEGORIES** — labels revised to plain
 * English on his instruction of 2026-08-06 (*«нормально назови разделы… на английском»*; the first
 * cut spelled the third button «Ждут», his word from the R38 conversation, and he rejected it).
 *
 * | Button | Category | Meaning |
 * |---|---|---|
 * | Inbox   | `new`                 | waiting for a FIRST answer |
 * | Open    | `open`                | we owe a reply |
 * | Pending | `pending` + `on_hold` | we wait on them / parked — his «всё валится в on hold» |
 * | Solved  | `solved`              | one bucket; channel lives inside as a column |
 * | Archive | `closed`              | subpoint 2.9's archive — closed work, one honest place |
 *
 * ⚠️ "Pending" the BUTTON covers two categories, one of which is also a status named Pending — the
 * same overloading Zendesk itself has, and the operator reads Zendesk daily. The button narrows by
 * CATEGORIES; the status funnel inside it narrows by KEY. Two different questions, two controls.
 *
 * ⭐⭐ **Buckets filter by `status_category`, NEVER by a status key.** Nine statuses collapse into
 * five buttons by themselves; a status the account configures later lands in the right button with
 * no code change; and it removes the defect class that cost an evening on 2026-08-05 — the previous
 * rail spelled the retired key `resolved`, and every agent who clicked got a 400 and a blank screen.
 * If a status ever needs to move buckets, it moves by changing THE STATUS'S CATEGORY — one data row —
 * never by an exception here. `buckets.test.tsx` plants exactly that shape to prove the detector
 * would catch it.
 *
 * ⚠️ **No numbers on any button, deliberately (R38).** Counts are 9.2a's, the unread badge is 9.12's;
 * a number that is sometimes stale is worse than no number.
 *
 * ⓘ **The whole screen is scoped to the signed-in agent** — see `use-inbox-query`. That is not a
 * bucket concern: every bucket shows *my* slice of its category. (Operator, 2026-08-06: «Менеджеру и
 * так только его тикеты приходят в инбокс и только его должны быть видны в open, solved, pending».)
 */
export type BucketId = 'inbox' | 'open' | 'pending' | 'solved' | 'archive';

export interface Bucket {
  readonly id: BucketId;
  readonly label: string;
  /**
   * What the bucket narrows to, merged under whatever the person has filtered.
   *
   * ⚠️ Always `statusCategories` — see the header. Switching buckets clears the filters that answer
   * the same "which state" question (`BUCKET_OWNED_KEYS`), so a status picked inside Pending cannot
   * silently empty Solved.
   */
  readonly filters: InboxFilters;
  /**
   * The categories this bucket shows — the SAME strings `filters.statusCategories` carries, split.
   * The status funnel derives its options from this: only statuses of the current bucket's
   * categories are offered, so a contradictory key-in-category ask is unbuildable by UI.
   */
  readonly categories: readonly string[];
}

export const BUCKETS: readonly Bucket[] = [
  { id: 'inbox', label: 'Inbox', categories: ['new'], filters: { statusCategories: 'new' } },
  { id: 'open', label: 'Open', categories: ['open'], filters: { statusCategories: 'open' } },
  {
    id: 'pending',
    label: 'Pending',
    categories: ['pending', 'on_hold'],
    filters: { statusCategories: 'pending,on_hold' },
  },
  { id: 'solved', label: 'Solved', categories: ['solved'], filters: { statusCategories: 'solved' } },
  /**
   * ⭐ Subpoint 2.9's archive: `closed` is a real category with real rows. The GROUPINGS the operator
   * described (his Zendesk's 18 views) are combinations of axes this screen already has — bucket ×
   * channel × priority; the SAVED form of them is 9.2a's views.
   */
  { id: 'archive', label: 'Archive', categories: ['closed'], filters: { statusCategories: 'closed' } },
];

export const DEFAULT_BUCKET: BucketId = 'inbox';

/**
 * The filter keys that answer the same question a bucket answers ("which state"), cleared on every
 * bucket switch. `status` is here because an exact key picked inside one bucket contradicts the next
 * bucket's categories — the server would answer honestly (an empty page), but nothing on screen
 * would explain it. Channel and priority survive a switch: different axes.
 */
export const BUCKET_OWNED_KEYS = ['statusCategories', 'status'] as const;

export function bucketById(id: BucketId): Bucket {
  const found = BUCKETS.find((b) => b.id === id);
  if (!found) throw new Error(`no such bucket: ${id}`);
  return found;
}
