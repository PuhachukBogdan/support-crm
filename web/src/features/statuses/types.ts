/** W15a (subpoint 3.14) — the status authoring screen's shapes. */

/** One definition, category normalised to the bare word (`open`, not the wire enum spelling). */
export interface StatusDef {
  key: string;
  category: string;
  agentName: string;
  endUserName: string;
  active: boolean;
  order: number;
}

/** The read's wire shape (`GET /conversations/statuses`, feature 032). */
export interface StatusWire {
  key?: string;
  category?: string;
  agentName?: string;
  endUserName?: string;
  active?: boolean;
  order?: number;
}

/**
 * ⚠️ The six categories live server-side in `libs/common/src/statuses/categories.ts` and there is
 * no route that lists them — the same trade the people screen recorded for its roles: a category
 * added there will not appear in this control until this list is edited too, and the closed set has
 * not changed since ADR 0040 defined it. The DISPLAY ORDER here mirrors the reference frame
 * (admin-center/068): the life of a ticket, left to right.
 */
export const STATUS_CATEGORIES = ['new', 'open', 'pending', 'on_hold', 'solved', 'closed'] as const;

const CATEGORY_PREFIX = 'CONVERSATION_STATUS_CATEGORY_';

/** Wire → bare word (`CONVERSATION_STATUS_CATEGORY_ON_HOLD` → `on_hold`). */
export function categoryFromWire(value: string | undefined): string {
  return String(value ?? '').replace(CATEGORY_PREFIX, '').toLowerCase();
}
