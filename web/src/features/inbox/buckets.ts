import type { InboxFilters } from './use-inbox-query';

/**
 * ⭐ **R39 (operator, 2026-08-07, reviewing the RUNNING product): FOUR buckets, and the archive moves
 * INSIDE the rail as a SECTION.** Supersedes R38's five-button layout (Inbox·Open·Pending·Solved·
 * Archive) — his own words, first narrow then revised in the same breath: *«самый лучший вариант…
 * открытые тикеты и новые, они будут в одной вкладке. Потом тикеты, которые в работе, будут
 * отдельно»*. An Inbox that also holds work already in progress stops being a queue.
 *
 * | Button | Categories | Meaning |
 * |---|---|---|
 * | Inbox        | `new` + `open` | new, and where the answer is on US — the queue |
 * | В работе     | `on_hold`      | `in_progress` · `follow_up` · `supervisor_review` · `auto_ended_chat` |
 * | Ждут клиента | `pending`      | `pending` · `vip_pending` — we wait on THEM |
 * | Решённые     | `solved`       | |
 * — then a SEPARATOR with a heading, and below it the archive section: —
 * | Весь архив   | `closed`       | closed work; W33's views will fill this section |
 *
 * ⓘ **Label language: R39's own words, as written in the reference (Document 6) and in the plan's
 * W23 row — both reviewed by the operator, both newer than his 2026-08-06 «на английском»
 * instruction, which named the R38 rail this composition replaces.** `Inbox` stays `Inbox` in every
 * version of his words. If he rejects the Russian, it is one string per bucket.
 *
 * **Approvals are a FILTER inside «В работе», never a fifth button (R39, выбрано).**
 * `supervisor_review` shares the `on_hold` category with `in_progress` and `follow_up`, so a
 * separate button would have to filter by a STATUS KEY — exactly the defect class R38 exists to
 * prevent (the old rail spelled the retired key `resolved`; every click was a 400 and a blank
 * screen). The status funnel already narrows by key *inside* a bucket, so the capability exists
 * without breaking the rule.
 *
 * ⭐⭐ **Buckets filter by `status_category`, NEVER by a status key** (R38's rule, kept by R39 word
 * for word). Nine statuses collapse into these buttons by themselves; a status the account
 * configures later lands in the right button with no code change. If a status ever needs to move
 * buckets, it moves by changing THE STATUS'S CATEGORY — one data row — never by an exception here.
 * `buckets.test.tsx` plants exactly that shape to prove the detector would catch it.
 *
 * ⚠️ **No numbers on any button, deliberately (R38, kept by R39).** Counts are 9.2a's, the unread
 * badge is 9.12's; a number that is sometimes stale is worse than no number.
 *
 * ⓘ **The whole screen is scoped to the signed-in agent** — see `use-inbox-query`. That is not a
 * bucket concern: every bucket shows *my* slice of its category.
 */
export type BucketId =
  | 'inbox'
  | 'inwork'
  | 'waiting'
  | 'solved'
  | 'archive'
  // W27 / 036 (9.16): the two shelf buckets — permission-gated entries of the archive section.
  | 'suspended'
  | 'deleted';

export interface Bucket {
  readonly id: BucketId;
  readonly label: string;
  /**
   * What the bucket narrows to, merged under whatever the person has filtered.
   *
   * ⚠️ Always `statusCategories` — see the header. Switching buckets clears the filters that answer
   * the same "which state" question (`BUCKET_OWNED_KEYS`), so a status picked inside «Ждут клиента»
   * cannot silently empty «Решённые».
   */
  readonly filters: InboxFilters;
  /**
   * The categories this bucket shows — the SAME strings `filters.statusCategories` carries, split.
   * The status funnel derives its options from this: only statuses of the current bucket's
   * categories are offered, so a contradictory key-in-category ask is unbuildable by UI — and it is
   * also how «на согласовании» works inside «В работе» without a fifth button.
   */
  readonly categories: readonly string[];
}

/** The four buckets above the separator — the working rail (R39). */
export const BUCKETS: readonly Bucket[] = [
  {
    id: 'inbox',
    label: 'Inbox',
    categories: ['new', 'open'],
    filters: { statusCategories: 'new,open' },
  },
  {
    id: 'inwork',
    label: 'В работе',
    categories: ['on_hold'],
    filters: { statusCategories: 'on_hold' },
  },
  {
    id: 'waiting',
    label: 'Ждут клиента',
    categories: ['pending'],
    filters: { statusCategories: 'pending' },
  },
  { id: 'solved', label: 'Решённые', categories: ['solved'], filters: { statusCategories: 'solved' } },
];

/**
 * ⭐ The archive SECTION (R47): below a labelled separator, same page, same list — never a separate
 * screen. In W23 it holds ONE entry («весь архив», the `closed` category — real rows since 2.9);
 * the per-category views the operator described are W33's, and they land HERE when granted.
 */
export const ARCHIVE_HEADING = 'Архив';
export const ARCHIVE_BUCKETS: readonly Bucket[] = [
  {
    id: 'archive',
    label: 'Весь архив',
    categories: ['closed'],
    filters: { statusCategories: 'closed' },
  },
];

/**
 * ⭐ W27 / 036 (roadmap 9.16) — the SHELF buckets: the third place a conversation can be, out of
 * every queue and not gone. They live in the archive section (the same "not the working rail"
 * region R47 defined) and are offered ONLY to holders of `crm.conversation.shelf.view` — the rail
 * hides them as a courtesy, the server refuses the filter for everyone else regardless.
 *
 * ⚠️ They narrow by the `shelved` filter, NOT by a status category: a shelved conversation keeps
 * whatever status it had, so `categories` is empty and the funnel offers nothing to slice by —
 * which is honest: the bucket's one axis is the shelf itself.
 */
export const SHELF_VIEW_PERMISSION = 'crm.conversation.shelf.view';
export const SHELF_BUCKETS: readonly Bucket[] = [
  { id: 'suspended', label: 'Придержанные', categories: [], filters: { shelved: 'suspended' } },
  { id: 'deleted', label: 'Удалённые', categories: [], filters: { shelved: 'deleted' } },
];

/** Every narrowing the rail can select — the working buckets, the archive's, and the shelf's. */
export const ALL_BUCKETS: readonly Bucket[] = [...BUCKETS, ...ARCHIVE_BUCKETS, ...SHELF_BUCKETS];

export const DEFAULT_BUCKET: BucketId = 'inbox';

/**
 * The filter keys that answer the same question a bucket answers ("which state"), cleared on every
 * bucket switch. `status` is here because an exact key picked inside one bucket contradicts the next
 * bucket's categories — the server would answer honestly (an empty page), but nothing on screen
 * would explain it. Channel and priority survive a switch: different axes.
 * ⚠️ `shelved` is here for the sharper reason: left behind on a switch to «Inbox» it would silently
 * turn the queue into the Suspended bucket — same rows requested, entirely different question.
 */
export const BUCKET_OWNED_KEYS = ['statusCategories', 'status', 'shelved'] as const;

export function bucketById(id: BucketId): Bucket {
  const found = ALL_BUCKETS.find((b) => b.id === id);
  if (!found) throw new Error(`no such bucket: ${id}`);
  return found;
}
