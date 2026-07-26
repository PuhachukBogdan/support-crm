import {
  clampPageSize,
  decodeCursor,
  encodeCursor,
  InvalidCursorError,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type Cursor,
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
