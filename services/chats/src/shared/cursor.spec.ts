import {
  clampPageSize,
  decodeCursor,
  decodeOrderedCursor,
  encodeCursor,
  encodeOrderedCursor,
  InvalidCursorError,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type Cursor,
  type OrderedCursor,
} from './cursor';

describe('keyset cursor (R7/N1)', () => {
  it('round-trips a cursor', () => {
    const c: Cursor = { createdAt: '2026-07-22T10:00:00.000Z', id: 'abc-123' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('treats an empty token as the first page (null)', () => {
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('rejects a malformed token (never a silent unfiltered fallback)', () => {
    expect(() => decodeCursor('not-base64-$$$')).toThrow(InvalidCursorError);
    // valid base64 but wrong shape:
    expect(() => decodeCursor(Buffer.from('{"x":1}').toString('base64url'))).toThrow(
      InvalidCursorError,
    );
  });

  it('clamps page size: default when unset, capped when oversized', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(-5)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(1000)).toBe(MAX_PAGE_SIZE);
  });
});

/**
 * T005 (feature 029, research R8) — the ORDER-STAMPED cursor, for the one list that has more than one
 * order.
 *
 * ── The defect this exists to make impossible ────────────────────────────────────────────────────
 * A keyset cursor means "resume after this row IN THIS SEQUENCE". The plain two-value token above
 * cannot say which sequence, because until feature 029 there was only ever one. Replay a token minted
 * under `updated_desc` while asking for `updated_asc` and it decodes perfectly — then pages a
 * DIFFERENT sequence. The result is not an error: it is a plausible list with rows missing and rows
 * repeated, and nobody can see it by looking.
 *
 * ⇒ The order rides INSIDE the token, and a mismatch is refused. The front end also restarts paging on
 * an order change, but that is the convenience; this is the guarantee.
 */
describe('*** the order-stamped cursor refuses a token from another sequence (R8) ***', () => {
  const DESC = 'updated_desc';
  const ASC = 'updated_asc';

  it('round-trips when the order matches', () => {
    const c: OrderedCursor = { sortKey: '2026-08-02T10:00:00.000Z', id: 'abc-123', order: DESC };
    expect(decodeOrderedCursor(encodeOrderedCursor(c), DESC)).toEqual(c);
  });

  it('treats an empty token as the first page (null)', () => {
    expect(decodeOrderedCursor('', DESC)).toBeNull();
    expect(decodeOrderedCursor(undefined, DESC)).toBeNull();
  });

  it('⭐ REFUSES a token minted under the other order — never pages a different sequence', () => {
    const mintedUnderDesc = encodeOrderedCursor({
      sortKey: '2026-08-02T10:00:00.000Z',
      id: 'abc-123',
      order: DESC,
    });
    expect(() => decodeOrderedCursor(mintedUnderDesc, ASC)).toThrow(InvalidCursorError);
  });

  it('REFUSES a legacy two-value token rather than assuming an order for it', () => {
    const legacy = encodeCursor({ createdAt: '2026-08-02T10:00:00.000Z', id: 'abc-123' });
    expect(() => decodeOrderedCursor(legacy, DESC)).toThrow(InvalidCursorError);
  });

  it('REFUSES a malformed token (never a silent unfiltered fallback)', () => {
    expect(() => decodeOrderedCursor('not-base64-$$$', DESC)).toThrow(InvalidCursorError);
    expect(() => decodeOrderedCursor(Buffer.from('{"x":1}').toString('base64url'), DESC)).toThrow(
      InvalidCursorError,
    );
  });

  it('the PLAIN decoder refuses an order-stamped token — the two vocabularies do not overlap', () => {
    // Otherwise a conversation token would be accepted by the message/feed endpoints, whose sequence
    // it has nothing to do with.
    const ordered = encodeOrderedCursor({ sortKey: '2026-08-02T10:00:00.000Z', id: 'x', order: DESC });
    expect(() => decodeCursor(ordered)).toThrow(InvalidCursorError);
  });
});
