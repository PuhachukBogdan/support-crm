import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_PAGE_SIZE,
} from './keyset';

/**
 * T002 (feature 018) — the paging primitive.
 *
 * The load-bearing assertion is the **throw**, not the round-trip. A cursor that silently degrades to
 * "first page" on a bad token turns a client bug into a server answering a different question, and the
 * answer looks successful — which is the failure mode this project has now met three times in different
 * guises (an unknown message kind coerced to a default, an unknown filter dropped, an unrecognised enum
 * member becoming UNSPECIFIED).
 */
describe('a cursor survives a round trip', () => {
  it('preserves both components exactly', () => {
    const c = { createdAt: '2026-07-28T10:00:00.000Z', id: 'ply-1' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('produces a URL-safe token — no padding, no + or /', () => {
    // base64url, because this value travels in a query string. Standard base64 would need escaping and
    // would break the moment somebody forgot to.
    const token = encodeCursor({ createdAt: '2026-07-28T10:00:00.000Z', id: 'a/b+c=d' });
    expect(token).not.toMatch(/[+/=]/);
  });

  it('is opaque — the id is not readable from the token by eye', () => {
    const token = encodeCursor({ createdAt: '2026-07-28T10:00:00.000Z', id: 'ply-secret' });
    expect(token).not.toContain('ply-secret');
  });
});

describe('an empty token is the FIRST page, not an error', () => {
  it.each([undefined, null, ''])('%p decodes to null', (token) => {
    expect(decodeCursor(token as string | undefined)).toBeNull();
  });
});

describe('*** a malformed token THROWS — it never degrades to the first page ***', () => {
  it.each([
    ['not base64 at all', '!!!!'],
    ['base64 of nonsense', Buffer.from('nonsense', 'utf8').toString('base64url')],
    ['a JSON object instead of a pair', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
    ['a one-element array', Buffer.from('["2026-07-28"]', 'utf8').toString('base64url')],
    ['a three-element array', Buffer.from('["a","b","c"]', 'utf8').toString('base64url')],
    ['non-string members', Buffer.from('[1,2]', 'utf8').toString('base64url')],
    ['an empty createdAt', Buffer.from('["","id"]', 'utf8').toString('base64url')],
    ['an empty id', Buffer.from('["2026-07-28T10:00:00.000Z",""]', 'utf8').toString('base64url')],
  ])('%s is refused', (_label, token) => {
    expect(() => decodeCursor(token)).toThrow(InvalidCursorError);
  });

  it('a truncated token is refused rather than partially read', () => {
    const token = encodeCursor({ createdAt: '2026-07-28T10:00:00.000Z', id: 'ply-1' });
    expect(() => decodeCursor(token.slice(0, token.length - 4))).toThrow(InvalidCursorError);
  });
});

describe('a well-formed token from ANOTHER query is ACCEPTED, deliberately', () => {
  it('decodes normally — the token carries no query identity to check', () => {
    /**
     * Asserted as a POSITIVE, because the temptation is to read "opaque" as "validated against the
     * query that made it". It is not, and it cannot be: the token is a position, nothing more.
     *
     * What makes that safe lives in the caller, not here — every predicate (account, brand) is
     * re-applied on every page and none of them travels inside the token. So a foreign cursor can
     * shift where a page begins and can never widen what the page may contain.
     *
     * Feature 018's analysis pass found a requirement promising such a token would be REFUSED. This
     * test exists so nobody tries to implement that promise by adding a filter hash and quietly
     * breaking every cursor already in flight.
     */
    const fromAnotherQuery = { createdAt: '2020-01-01T00:00:00.000Z', id: 'ply-from-elsewhere' };
    expect(decodeCursor(encodeCursor(fromAnotherQuery))).toEqual(fromAnotherQuery);
  });
});

describe('page size is clamped by the SERVER, whatever a caller asks', () => {
  it.each([
    [undefined, DEFAULT_PAGE_SIZE],
    [null, DEFAULT_PAGE_SIZE],
    [0, DEFAULT_PAGE_SIZE],
    [-5, DEFAULT_PAGE_SIZE],
    [1, 1],
    [25, 25],
    [MAX_PAGE_SIZE, MAX_PAGE_SIZE],
    [MAX_PAGE_SIZE + 1, MAX_PAGE_SIZE],
    [10_000, MAX_PAGE_SIZE],
  ])('%p becomes %i', (asked, expected) => {
    expect(clampPageSize(asked as number | undefined)).toBe(expected);
  });

  it('a fractional request is floored, not rounded up past the cap', () => {
    expect(clampPageSize(10.9)).toBe(10);
    expect(clampPageSize(MAX_PAGE_SIZE + 0.5)).toBe(MAX_PAGE_SIZE);
  });
});
