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
  // Feature 022: which HUMAN this record belongs to. ⚠️ **Its absence was caught by the live run — the
  // SECOND time this list dropped a newly added field, `brandId` above being the first.** Twice is a
  // pattern, so `player-projection-covers-contract.spec.ts` now derives the expected set from the proto
  // and fails when a field is declared and not projected. An allow-list doing its job is correct; an
  // allow-list nobody is obliged to update is a silent filter.
  'personId',
  'vip',
  'segment',
  'amNotes',
  'customAttributesJson',
  'preferencesJson',
  'portfolioJson',
] as const;

/** Exported so the coverage guard compares against the real list rather than a copy of it. */
export const PROJECTED_PLAYER_FIELDS: readonly string[] = PLAYER_FIELDS;

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
// ⭐ W11 (9.17): `playerIdPrefix` joins the allow-list — the directory's search, by the PLATFORM ID
// the agent already has. ⛔ Deliberately no `email`/`phone` key here, now or later: searching by a
// contact is the anti-pitching inversion and it exists only under a conversation (ADR 0044 §4).
const ALLOWED_LIST_PARAMS = ['brandId', 'pageSize', 'pageToken', 'playerIdPrefix'] as const;

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
  /** W11 (9.17): a platform-id prefix, `''` when absent. Never a contact value. */
  playerIdPrefix: string;
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

  // W11: the id prefix, trimmed. ⚠️ Bounded at 64 — a platform id is short, and an unbounded value
  // on a `startsWith` is a free scan of an indexed column. Refused rather than truncated: a
  // silently shortened search returns rows the caller did not ask about.
  const playerIdPrefix = typeof query?.playerIdPrefix === 'string' ? query.playerIdPrefix.trim() : '';
  if (playerIdPrefix.length > 64) throw new BadRequestException('playerIdPrefix is too long');

  return {
    brandId,
    pageSize: parsePageSize(query?.pageSize),
    pageToken: typeof query?.pageToken === 'string' ? query.pageToken : '',
    playerIdPrefix,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ W35 / feature 040 — player notes at the edge.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The note projection — an EXPLICIT list, like the player one above and for the same reason: a field
 * added to the message must not reach a browser because nobody remembered this file.
 *
 * ⚠️ Unlike `toPlayerResponse` this does NOT drop default-valued fields, and the difference is
 * deliberate. That rule exists so a MASKED field is indistinguishable from an empty one — a note has no
 * masked fields: the whole row is either served or refused. Dropping empties here would instead delete
 * meaning, because `authorDisplayName: ''` is a real answer ("no profile resolves this author, show the
 * reference") and `patternKinds: []` is another ("nothing was flagged"). An absent key would make the
 * screen guess at both.
 */
const NOTE_FIELDS = ['id', 'body', 'authorRef', 'authorDisplayName', 'createdAt', 'patternKinds'] as const;

export const PROJECTED_NOTE_FIELDS: readonly string[] = NOTE_FIELDS;

export function toNoteResponse(msg: unknown): Record<string, unknown> {
  const src = (msg ?? {}) as Record<string, unknown>;
  return {
    id: String(src.id ?? ''),
    body: String(src.body ?? ''),
    authorRef: String(src.authorRef ?? ''),
    authorDisplayName: String(src.authorDisplayName ?? ''),
    createdAt: String(src.createdAt ?? ''),
    patternKinds: Array.isArray(src.patternKinds) ? src.patternKinds.map(String) : [],
  };
}

export function toNotePageResponse(page: unknown): { notes: Record<string, unknown>[] } {
  const src = (page ?? {}) as { notes?: unknown[] };
  return { notes: (src.notes ?? []).map(toNoteResponse) };
}

/**
 * The notes LIST query.
 *
 * ── ⚠️ WHY THIS EXISTS AND IS NOT `parseGetQuery` ────────────────────────────────────────────────
 * The first version reused `parseGetQuery` (brandId and nothing else) and the LIVE RUN found it: the
 * browser's transport sends `pageSize` on every list read — it comes from the route registry's own row,
 * not from the screen — so every notes read in a real browser answered
 * **`400 unknown query parameter: pageSize`**. Nothing in the suite could see it: the unit tests call the
 * controller directly, and the API legs of the live check hand-build the query without paging.
 *
 * ⓘ And it hid twice over on the screen, which is the part worth remembering: the page LOOKED fine
 * because a stored note is prepended from the POST response, so «add a note and see it appear» passed
 * while the READ was failing the whole time. The panel, which has no POST, is where it surfaced.
 *
 * ⛔ `pageToken` is REFUSED rather than accepted-and-ignored. This contract has no paging: the card
 * section is one page by design, and the service clamps the size. Accepting a cursor we do not honour is
 * the silently-dropped-filter failure — the exact shape feature 017's live run found one layer deeper.
 */
export function parseNotesListQuery(query: Record<string, unknown>): { brandId: string; pageSize: number } {
  const allowed = ['brandId', 'pageSize'];
  const unknown = Object.keys(query ?? {}).filter((k) => !allowed.includes(k));
  // KEY names only — a query value can be a customer identifier (SEC-26).
  if (unknown.length > 0) {
    throw new BadRequestException(`unknown query parameter: ${unknown.sort().join(', ')}`);
  }
  const brandId = typeof query?.brandId === 'string' ? query.brandId.trim() : '';
  if (!brandId) throw new BadRequestException('brandId is required');
  return { brandId, pageSize: parsePageSize(query?.pageSize) };
}

/**
 * The add-note body, validated at the edge that accepts it.
 *
 * ⚠️ **`body` is NEVER echoed in an error message.** A validation failure that quoted the text would put
 * a note — possibly containing the very contact value this feature exists to notice — into the gateway's
 * error responses and, from there, into whatever logs them (SEC-26). Lengths and key names only.
 */
export interface AddNoteBody {
  brandId: string;
  body: string;
  acknowledged: boolean;
  clientRef: string;
}

const ALLOWED_NOTE_BODY_KEYS = ['brandId', 'body', 'acknowledged', 'clientRef'] as const;

export function parseAddNoteBody(raw: unknown): AddNoteBody {
  const src = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(src).filter(
    (k) => !(ALLOWED_NOTE_BODY_KEYS as readonly string[]).includes(k),
  );
  // Refused, not ignored — the same fail-closed stance as the query parsers above. KEY names only.
  if (unknown.length > 0) {
    throw new BadRequestException(`unknown field: ${unknown.sort().join(', ')}`);
  }

  const brandId = typeof src.brandId === 'string' ? src.brandId.trim() : '';
  if (!brandId) throw new BadRequestException('brandId is required');

  const body = typeof src.body === 'string' ? src.body : '';
  if (!body.trim()) throw new BadRequestException('body is required');

  // ⚠️ The bound is restated here as well as in the owning service, and that is not duplication of a
  // RULE — it is a parse limit. The service decides whether a note is acceptable; the edge declines to
  // forward a megabyte to find out. The numbers agree by test, not by comment.
  if (body.length > MAX_NOTE_BODY_LENGTH) throw new BadRequestException('body is too long');

  const clientRef = typeof src.clientRef === 'string' ? src.clientRef.trim() : '';
  if (!clientRef) throw new BadRequestException('clientRef is required');
  if (clientRef.length > 64) throw new BadRequestException('clientRef is too long');

  return { brandId, body, acknowledged: src.acknowledged === true, clientRef };
}

/** Mirrors `MAX_NOTE_LENGTH` in the owning service; `notes-edge.spec.ts` asserts they agree. */
export const MAX_NOTE_BODY_LENGTH = 4_000;

/**
 * The outcome enum, decoded by NAME as well as by tag.
 *
 * ⚠️ proto-loader runs with `enums: String`, so the wire carries `"ADD_NOTE_OUTCOME_STORED"`. Feature
 * 025 lost a live iteration to exactly this and it is written down twice
 * (`gotchas/grpc-wire-encoding-enums-longs`), so both spellings are accepted here — and an UNRECOGNISED
 * outcome is an upstream error, never a success. The wire drops zero values, so "no outcome" arrives as
 * `UNSPECIFIED` and must not read as "stored".
 */
const OUTCOME_WORD: Readonly<Record<string, string>> = {
  '1': 'stored',
  '2': 'needs_acknowledgement',
  '3': 'empty_body',
  '4': 'too_long',
  '5': 'no_such_player',
  ADD_NOTE_OUTCOME_STORED: 'stored',
  ADD_NOTE_OUTCOME_NEEDS_ACK: 'needs_acknowledgement',
  ADD_NOTE_OUTCOME_EMPTY_BODY: 'empty_body',
  ADD_NOTE_OUTCOME_TOO_LONG: 'too_long',
  ADD_NOTE_OUTCOME_NO_SUCH_PLAYER: 'no_such_player',
};

export function outcomeWord(raw: unknown): string {
  return OUTCOME_WORD[String(raw ?? '')] ?? '';
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
