import { BadRequestException } from '@nestjs/common';

/**
 * ⚠️ THE MASKING GUARANTEE'S LAST MILE (feature 019, 2026-07-29 — fixes a violation of 011's FR-014).
 *
 * **What was wrong.** FR-014 requires that "fields a role may not see are ABSENT from the serialized
 * response (not merely hidden client-side)". They were not. `maskPlayer` omits them correctly, and then
 * `toPlayerWire` in the users service wrote `?? ''` for each one; proto3 has no presence for singular
 * scalars, so every key arrived at the client, blanked. Recorded live:
 * `specs/019-gateway-transport/fixtures/player-get-{admin,support}.json` — `"segment":"standard"` for an
 * admin, `"segment":""` for a support agent. The value never leaked, so the *intent* of FR-014 held; its
 * letter did not, and a client could not tell "you may not see this" from "this is empty".
 *
 * **Why it was not caught.** 018's live comparison filtered `.value != ""` — it measured non-empty
 * VALUES while the contract it was checking spoke of KEYS. The assertion that would have failed was
 * looking somewhere else. Same lesson as 5.1: when a guarantee holds, check WHICH code makes it hold.
 *
 * **Why the fix is here and why it omits by VALUE rather than by clearance.** Two requirements pull in
 * opposite directions, and both are right:
 *   · FR-014 — a withheld field must be absent.
 *   · `toPlayerWire`'s own note — the response must not reveal WHICH fields were withheld, because that
 *     is itself a disclosure about the record.
 * Marking the proto fields `optional` would satisfy the first and BREAK the second: with explicit
 * presence a genuinely-empty field arrives as `""` while a withheld one is absent, which hands the caller
 * an exact list of what it was denied. (It also trips `buf breaking` on a cardinality change.)
 * Dropping every default-valued field satisfies both: absent means "nothing for you here", and the
 * caller cannot tell why. That is also just canonical protobuf→JSON, which this edge was not applying.
 *
 * **Consequence for producers and for the UI.** A producer must never write a placeholder into a
 * maskable field — `?? 'n/a'` would sail straight through this. And a surface cannot use emptiness to
 * decide whether to render a field: the deciding input is the caller's role.
 */
const PLAYER_FIELDS = [
  'playerId',
  'accountId',
  // Feature 020: the record's own brand — part of its identity, and the thing a card needs to show
  // which brand a customer came from. Its absence from this list was caught by the live run: the
  // explicit projection did its job and dropped a field nobody had added to it, which is the
  // difference between an allow-list and a spread.
  'brandId',
  'brandIds',
  'vip',
  'segment',
  'amNotes',
  'customAttributesJson',
  'preferencesJson',
  'portfolioJson',
] as const;

/** True for proto3's default of each supported kind — the values canonical JSON omits. */
function isProtoDefault(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    v === '' ||
    v === false ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );
}

/**
 * Project one decoded `Player` message to its REST body, dropping default-valued fields.
 *
 * An EXPLICIT field list, never a spread — the same rule the users service states for the row→wire
 * step, and for the same reason: a passthrough would forward whatever a future message gains, and the
 * one field deliberately absent from that contract is a customer PII snapshot.
 */
export function toPlayerResponse(msg: unknown): Record<string, unknown> {
  const src = (msg ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of PLAYER_FIELDS) {
    const value = src[key];
    if (!isProtoDefault(value)) out[key] = value;
  }
  return out;
}

/** The paged form. The token stays as-is: empty means exhausted, and that is a documented signal. */
export function toPlayerPageResponse(page: unknown): {
  players: Record<string, unknown>[];
  nextPageToken: string;
} {
  const src = (page ?? {}) as { players?: unknown[]; nextPageToken?: string };
  return {
    players: (src.players ?? []).map(toPlayerResponse),
    nextPageToken: src.nextPageToken ?? '',
  };
}

/**
 * Fail-closed query parsing for the players edge (feature 018, roadmap 5.1).
 *
 * ── An unrecognised parameter is REFUSED, never ignored ──────────────────────────────────────────
 * Dropping is the dangerous direction, and this feature has the clearest possible example of it: a
 * dropped `brandId` turns "the customers of one brand" into "every customer in the account". The reads
 * this edge serves are over contact-bearing records, so a widened result is the anti-pitching failure
 * itself, not a cosmetic bug.
 *
 * Feature 017's live run found the same class one layer deeper: a filter that passed validation and was
 * then silently discarded by the transport, producing a confident wrong answer.
 */
const ALLOWED_LIST_PARAMS = ['brandId', 'pageSize', 'pageToken'] as const;

/**
 * The single-record read takes `brandId` and nothing else (feature 020).
 *
 * Required, and refused rather than defaulted: GR8's `player_id` is unique only within a brand, so a
 * request naming only the platform id identifies two customers. Same fail-closed stance as the list —
 * an unrecognised parameter is refused, not ignored, because dropping is the widening direction.
 */
export function parseGetQuery(query: Record<string, unknown>): string {
  const unknown = Object.keys(query ?? {}).filter((k) => k !== 'brandId');
  if (unknown.length > 0) {
    // KEY names only — a query value can be a customer identifier (SEC-26).
    throw new BadRequestException(`unknown query parameter: ${unknown.sort().join(', ')}`);
  }
  const brandId = typeof query?.brandId === 'string' ? query.brandId.trim() : '';
  if (!brandId) throw new BadRequestException('brandId is required');
  return brandId;
}

export interface ListQuery {
  brandId: string;
  pageSize: number;
  pageToken: string;
}

/**
 * Parse the list query.
 *
 * `brandId` is **required**. An unfiltered "all customers" read is not an operation this feature offers,
 * and defaulting a missing brand to "all" would be the widening direction in its purest form — so its
 * absence is a client error rather than a broader query.
 */
export function parseListQuery(query: Record<string, unknown>): ListQuery {
  const unknown = Object.keys(query ?? {}).filter(
    (k) => !(ALLOWED_LIST_PARAMS as readonly string[]).includes(k),
  );
  if (unknown.length > 0) {
    // The KEY names are echoed, never the values — a query value can be a customer identifier (SEC-26).
    throw new BadRequestException(`unknown query parameter: ${unknown.sort().join(', ')}`);
  }

  const brandId = typeof query?.brandId === 'string' ? query.brandId.trim() : '';
  if (!brandId) throw new BadRequestException('brandId is required');

  return {
    brandId,
    pageSize: parsePageSize(query?.pageSize),
    pageToken: typeof query?.pageToken === 'string' ? query.pageToken : '',
  };
}

/**
 * Page size: absent ⇒ let the service decide; anything else invalid ⇒ 400.
 *
 * Never a silent fallback. `?pageSize=all` quietly becoming 50 teaches a client that the parameter is
 * advisory, and the next thing it does is send something else nonsensical on a path that matters.
 */
export function parsePageSize(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadRequestException('pageSize must be a positive integer');
  }
  return n;
}
