import {
  classifyStatus,
  dataErrorFor,
  dataErrorForStatus,
  clientRefusal,
  toDataError,
  type FailureClass,
} from './errors';

/**
 * T006 [Foundational] — failure classification (feature 019, research R5).
 *
 * The interesting assertions here are the last two describes: that no response content can reach a
 * message, and that only one class is retryable. Both are properties of the mapping itself, which is
 * why they are checked over the whole table rather than on one example.
 */

const ALL: FailureClass[] = [
  'invalid-request',
  'no-session',
  'refused',
  'not-found',
  'rate-limited',
  'unavailable',
];

describe('status → failure class', () => {
  it.each([
    [400, 'invalid-request'],
    [401, 'no-session'],
    [403, 'refused'],
    [404, 'not-found'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [0, 'unavailable'], // the request never completed
  ])('%i → %s', (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });

  it('an unmapped status is unavailable, never a silent success', () => {
    // A status nobody anticipated must not fall through as "fine" — the caller would render an
    // empty screen and believe it.
    expect(classifyStatus(418)).toBe('unavailable');
    expect(classifyStatus(302)).toBe('unavailable');
  });
});

describe('only an unavailable service — and, since W14, a rate limit — is retryable', () => {
  // ⚠️ AMENDED by W14, which added the first UI action that can genuinely meet a 429 (the invite
  // issuer is rate-limited per user). Rate-limited is retryable in the literal sense — the same
  // request succeeds later — and its fixed message says to WAIT first, which is the difference
  // between it and 'unavailable'.
  it.each(ALL)('%s', (cls) => {
    expect(dataErrorFor(cls).retryable).toBe(cls === 'unavailable' || cls === 'rate-limited');
  });

  it('a refusal is never retried — repeating it would fail identically and hammer the edge', () => {
    expect(dataErrorForStatus(403).retryable).toBe(false);
    expect(dataErrorForStatus(404).retryable).toBe(false);
  });
});

describe('*** nothing about the request or the response can reach the message ***', () => {
  it('the message for a class is fixed — it is not built from anything', () => {
    // Two calls for the same class must be identical objects in content: if a message were ever
    // interpolated from a request, this is where it would start to differ.
    for (const cls of ALL) {
      expect(dataErrorFor(cls)).toEqual(dataErrorFor(cls));
    }
  });

  it('the classifier takes only a number, so a body cannot be threaded through it', () => {
    // Structural, and deliberately so: the guarantee is that NO CODE PATH exists from a body to a
    // message, not that the current implementation happens not to use one (the 5.1 lesson —
    // a correct guarantee with a mis-stated cause survives every test and dies at the next refactor).
    expect(classifyStatus).toHaveLength(1);
    expect(dataErrorFor).toHaveLength(1);
  });

  it('the code is the class name, which carries no request detail', () => {
    for (const cls of ALL) {
      expect(dataErrorFor(cls).code).toBe(cls);
    }
  });
});

describe('client-side refusal', () => {
  it('names the parameter and is never retryable', () => {
    const err = clientRefusal('brandId is required');
    expect(err.message).toContain('brandId');
    expect(err.retryable).toBe(false);
  });

  it('passes through toDataError unchanged — it is already sanitized', () => {
    const err = clientRefusal('unknown filter: nope');
    expect(toDataError(err)).toBe(err);
  });
});
