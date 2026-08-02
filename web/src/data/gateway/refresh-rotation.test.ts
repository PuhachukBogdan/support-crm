import { withRefreshRotation, isAuthCall, REFRESH_PATH } from './rotating-port';
import type { HttpPort, HttpRequest, HttpResponse } from './http-port';

/**
 * T016 [027] — the Track-A half of the rotation. ⚠️ It is only a half, and the missing half is the
 * important one: **that the rotation fires against a real expiry** can only be shown on the live
 * stand (quickstart B4.2), because a mocked transport never expires anything.
 *
 * What IS provable here is the control flow, and every assertion below corresponds to a way the
 * rotation goes wrong in production:
 *
 *  - no retry at all      → the session dies at the short access lifetime (SC-005 fails)
 *  - retry more than once → a loop against a rate-limited authentication endpoint
 *  - retry on auth calls  → every failed sign-in costs two requests and refreshes nothing
 *  - the rotation's own answer returned → a failed refresh is reported as the original call's result
 */

/** A port that answers from a script and records what it was asked, in order. */
function scriptedPort(script: HttpResponse[]): { port: HttpPort; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  let i = 0;
  const port: HttpPort = async (req) => {
    calls.push(req);
    const res = script[Math.min(i, script.length - 1)]!;
    i += 1;
    return res;
  };
  return { port, calls };
}

const OK: HttpResponse = { status: 200, body: { ok: true } };
const UNAUTHORIZED: HttpResponse = { status: 401, body: { statusCode: 401 } };

describe('401 → refresh → retry, in the transport', () => {
  it('rotates once and replays the original request', async () => {
    const { port, calls } = scriptedPort([UNAUTHORIZED, OK, { status: 200, body: { me: 'u1' } }]);
    const rotating = withRefreshRotation(port);

    const res = await rotating({ path: '/auth/me' });

    expect(calls.map((c) => c.path)).toEqual(['/auth/me', REFRESH_PATH, '/auth/me']);
    expect(calls[1]!.method).toBe('POST');
    expect(res.body).toEqual({ me: 'u1' });
  });

  it('does not loop when the rotation itself is refused', async () => {
    // Every answer is a 401. A rotation that retried on the retry's failure would run forever here.
    const { port, calls } = scriptedPort([UNAUTHORIZED]);
    const lost = jest.fn();
    const rotating = withRefreshRotation(port, lost);

    const res = await rotating({ path: '/conversations' });

    expect(calls.map((c) => c.path)).toEqual(['/conversations', REFRESH_PATH]);
    expect(res).toBe(UNAUTHORIZED); // the ORIGINAL answer, not the rotation's
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('⚠️ never rotates on an auth call — a rejected password is not an expired token', async () => {
    const { port, calls } = scriptedPort([UNAUTHORIZED]);
    const lost = jest.fn();
    const rotating = withRefreshRotation(port, lost);

    const res = await rotating({ path: '/auth/login', method: 'POST', body: { email: 'a@b.test' } });

    expect(calls.map((c) => c.path)).toEqual(['/auth/login']);
    expect(res.status).toBe(401);
    expect(lost).not.toHaveBeenCalled();
  });

  it('leaves every non-401 answer alone', async () => {
    const { port, calls } = scriptedPort([{ status: 403, body: {} }]);
    const rotating = withRefreshRotation(port);

    const res = await rotating({ path: '/players/p1' });

    expect(calls).toHaveLength(1);
    expect(res.status).toBe(403);
  });

  it('knows every call that is part of the auth flow', () => {
    // A path missing from this set would be rotated on — which is how "every failed sign-in makes
    // two requests" gets shipped without anybody noticing.
    for (const path of [
      '/auth/login',
      '/auth/verify',
      '/auth/register/start',
      '/auth/register/complete',
      '/auth/logout',
      REFRESH_PATH,
    ]) {
      expect(isAuthCall(path)).toBe(true);
    }
    expect(isAuthCall('/auth/me')).toBe(false); // the one auth path that DOES need rotating
    expect(isAuthCall('/conversations')).toBe(false);
  });
});
