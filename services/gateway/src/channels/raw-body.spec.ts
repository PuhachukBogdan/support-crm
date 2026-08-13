import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * T019 (feature 033, research R3) — **a signature is over bytes, and bytes do not survive a round trip.**
 *
 * ── Why this test exists at all ─────────────────────────────────────────────────────────────────
 * `NestFactory.create(AppModule, { rawBody: true })` is one word in one file, and forgetting it produces a
 * failure that points at the wrong party: every delivery is refused, the provider's signature looks wrong,
 * and the obvious next step is to ask them to fix their signing. So the claim is pinned here rather than
 * left to a comment in `main.ts`.
 *
 * The test does not boot the gateway — it demonstrates the PROPERTY that makes the flag necessary, which is
 * the thing a future reader needs to understand before they "simplify" the bootstrap. The route itself is
 * exercised end to end by `deploy/local/live-w3.sh`.
 */
const SECRET = 'a-shared-secret-of-at-least-32-characters';

const sign = (timestamp: number, body: string): string =>
  createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');

const verify = (timestamp: number, body: string, signature: string): boolean => {
  const expected = Buffer.from(sign(timestamp, body), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  // Length-checked first: `timingSafeEqual` throws on a mismatch rather than returning false.
  return expected.length === given.length && timingSafeEqual(expected, given);
};

describe('why the gateway must preserve raw bodies', () => {
  /**
   * ⚠️ Deliberately NOT in `JSON.stringify` canonical form — it has spaces after the colons, the way a
   * provider that pretty-prints its payload sends it.
   *
   * The first draft of this test used a canonical string, so re-serialising it was a no-op and the
   * assertion below failed. That failure is the lesson in miniature: the round trip is only lossless when
   * the sender happens to serialise exactly the way we do, and nothing about a third party's payload
   * guarantees that. Trusting it means the route works against one provider and silently rejects the next.
   */
  const RAW = '{"event_id": "evt-1", "message": {"text": "hello"}, "meta": {"b": 2, "a": 1}}';
  const TS = 1_770_000_000;

  it('the signature verifies against the bytes as sent', () => {
    expect(verify(TS, RAW, sign(TS, RAW))).toBe(true);
  });

  it('⭐ parse-then-reserialise BREAKS the signature even though the data is identical', () => {
    // This is the whole argument for `rawBody: true`. The object is equal; the bytes are not.
    const reserialised = JSON.stringify(JSON.parse(RAW));
    expect(JSON.parse(reserialised)).toEqual(JSON.parse(RAW)); // same data...
    expect(reserialised).not.toBe(RAW); // ...different bytes (whitespace here; key order elsewhere)
    expect(verify(TS, reserialised, sign(TS, RAW))).toBe(false);
  });

  it('a body altered by one character does not verify', () => {
    const tampered = RAW.replace('hello', 'hellp');
    expect(verify(TS, tampered, sign(TS, RAW))).toBe(false);
  });

  it('the timestamp is INSIDE the signed string, so it cannot be edited in transit', () => {
    // Binding it is what stops a captured body being replayable for ever — and stops the replay window
    // being widened by whoever captured it.
    expect(verify(TS + 1, RAW, sign(TS, RAW))).toBe(false);
  });

  it('comparison is length-checked before it is constant-time', () => {
    // `timingSafeEqual` throws on differing lengths. A verifier that let that throw would turn a malformed
    // signature into a 500, which is an availability bug reachable by anybody who can post to the route.
    expect(() => verify(TS, RAW, 'short')).not.toThrow();
    expect(verify(TS, RAW, 'short')).toBe(false);
  });
});
