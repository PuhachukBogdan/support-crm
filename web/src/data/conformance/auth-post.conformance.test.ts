import { AUTH_RECORDINGS } from './subjects';
import { fixturePort, loadFixture, fixtureNames } from '../gateway/fixture-port';

/**
 * T009 [027] — the auth POST shape, exercised against RECORDED responses.
 *
 * The reads have had this since feature 019; the writes this feature adds join it rather than being
 * driven by bodies somebody typed. What is asserted here is the transport-facing half:
 *
 *  - every declared recording actually exists on disk (a list naming a file that is not there is a
 *    corpus that silently shrank);
 *  - a POST reaches the port with its method and body intact and **no query** — the FR-015 rule at
 *    the layer that would break it;
 *  - the refusal bodies are read as STATUS, never as content. `/auth/me` proves why: it is the one
 *    route whose refusal body has a different shape entirely.
 */

describe('conformance — the auth POST shape against recorded responses', () => {
  it('every declared auth recording exists in the corpus', () => {
    const present = new Set(fixtureNames());
    const missing = AUTH_RECORDINGS.filter((r) => !present.has(r.name)).map((r) => r.name);
    expect(missing).toEqual([]);
  });

  it('every recording carries no token, code or password', () => {
    for (const { name, refusal } of AUTH_RECORDINGS) {
      const rec = loadFixture(name);
      expect(`${name}:${rec.status}`).toBe(`${name}:${refusal ? 401 : 200}`);
      const serialised = JSON.stringify(rec.body);
      // A recording is committed to the repository. If a secret ever reached one, it would be
      // committed too — so the corpus asserts its own cleanliness rather than trusting the recorder.
      // The tokens live in `Set-Cookie` headers, which are deliberately not recorded at all.
      expect(serialised).not.toMatch(/token(?!Id)|password|"code"|secret|accessToken|refreshToken/i);
    }
  });

  it('⭐ the RECORDED challenge proves codeExpiresAt is UNIX seconds', () => {
    // The single number the expired-versus-wrong distinction rests on (FR-012). Recorded off the
    // live gateway rather than typed: had it been milliseconds, the client's comparison against
    // `Date.now()/1000` would read every code as valid for the next fifty thousand years.
    const body = loadFixture('auth-login-code-sent').body as {
      challengeId: string;
      codeExpiresAt: number;
    };

    expect(typeof body.challengeId).toBe('string');
    // Seconds since the epoch land in the 1.7–2.0 billion range; the same instant in milliseconds
    // is a thousand times larger, and this window is what tells them apart.
    expect(body.codeExpiresAt).toBeGreaterThan(1_600_000_000);
    expect(body.codeExpiresAt).toBeLessThan(2_000_000_000);
  });

  it('the recorded success bodies carry no session material at all', () => {
    // `verify` answers `{status:'ok'}` and puts the session in httpOnly cookies. If a token ever
    // appeared in a BODY, a page could read it — which is the whole thing the cookie design avoids.
    expect(loadFixture('auth-verify-ok').body).toEqual({ status: 'ok' });
  });

  it('replays a POST through the port with the method and body intact, and no query', async () => {
    const { port, calls } = fixturePort([loadFixture('auth-login-invalid')]);
    const res = await port({
      path: '/auth/login',
      method: 'POST',
      body: { email: 'a@b.test', password: 'pw' },
    });

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ email: 'a@b.test', password: 'pw' });
    expect(calls[0]!.query).toBeUndefined();
  });

  it('⭐ the refusal bodies do NOT share a shape — which is why nothing reads them', () => {
    // Controller-produced refusals answer `{status}`; the guard-produced one answers Nest's
    // `{message, statusCode}`. Any code branching on the body would work on four routes and fail on
    // the fifth — the one the session asks on every navigation.
    const controllerRefusal = loadFixture('auth-login-invalid').body as Record<string, unknown>;
    const guardRefusal = loadFixture('auth-me-unauthenticated').body as Record<string, unknown>;

    expect(controllerRefusal).toHaveProperty('status');
    expect(guardRefusal).not.toHaveProperty('status');
    expect(guardRefusal).toHaveProperty('statusCode');
  });
});
