import { BadRequestException } from '@nestjs/common';

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
