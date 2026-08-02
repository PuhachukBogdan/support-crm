import { GatewaySession } from './gateway-session';
import { fixturePort, loadFixture } from '../data/gateway/fixture-port';
import type { HttpPort, HttpRequest, HttpResponse } from '../data/gateway/http-port';

/**
 * T014 [027] — the gateway-backed session, against RECORDED refusals where they exist.
 *
 * ⚠️ The assertion this file is really built around is the one that separates a **failure to ask**
 * from a **negative answer**. Every other test here would pass if `unreachable` were quietly folded
 * into `rejected`, and the product would then log the whole floor out on a blip.
 */

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

const DEAD: HttpResponse = { status: 0, body: undefined }; // the adapter's "never completed"

describe('GatewaySession — resolving who this is', () => {
  it('a 200 with an identity is authenticated', async () => {
    const { port } = scriptedPort([
      { status: 200, body: { userId: 'u1', accountId: 'a1', roles: ['agent'] } },
    ]);
    const state = await new GatewaySession(port).resolve();
    expect(state).toEqual({ kind: 'authenticated', userId: 'u1', accountId: 'a1', roles: ['agent'] });
  });

  it('the RECORDED 401 from /auth/me is anonymous — and its body is never read', async () => {
    // The recording is Nest's `{message, statusCode}`, not the `{status}` every other route uses.
    const recorded = loadFixture('auth-me-unauthenticated');
    const { port } = fixturePort([recorded]);
    expect(await new GatewaySession(port).resolve()).toEqual({ kind: 'anonymous' });
  });

  it('⭐ a transport failure is unreachable, NOT anonymous', async () => {
    const { port } = scriptedPort([DEAD]);
    expect(await new GatewaySession(port).resolve()).toEqual({ kind: 'unreachable' });
  });

  it('a gateway 5xx is unreachable too — the service failed, the session did not end', async () => {
    const { port } = scriptedPort([{ status: 502, body: undefined }]);
    expect(await new GatewaySession(port).resolve()).toEqual({ kind: 'unreachable' });
  });

  it('a 200 without an identity is unreachable, not a signed-out answer', async () => {
    const { port } = scriptedPort([{ status: 200, body: {} }]);
    expect(await new GatewaySession(port).resolve()).toEqual({ kind: 'unreachable' });
  });

  it('starts in resolving and never reports an answer it has not received', async () => {
    expect(new GatewaySession(scriptedPort([DEAD]).port).state()).toEqual({ kind: 'resolving' });
  });
});

describe('GatewaySession — signing in', () => {
  it('the RECORDED challenge moves to the code step, carrying the expiry unconverted', async () => {
    // Replayed from the live gateway (`auth-login-code-sent`), so the shape and the UNITS of
    // `codeExpiresAt` are the server's rather than this test's idea of them.
    const recorded = loadFixture('auth-login-code-sent');
    const expected = recorded.body as { challengeId: string; codeExpiresAt: number };
    const { port, calls } = fixturePort([recorded]);
    const outcome = await new GatewaySession(port).signIn('a@b.test', 'pw');

    expect(outcome).toEqual({
      kind: 'code_sent',
      challengeId: expected.challengeId,
      codeExpiresAt: expected.codeExpiresAt,
    });
    expect(calls[0]).toEqual({
      path: '/auth/login',
      method: 'POST',
      body: { email: 'a@b.test', password: 'pw' },
    });
    expect(calls[0]!.query).toBeUndefined(); // FR-015, at the layer that would break it
  });

  it('the RECORDED 401 is a rejection that says nothing about the address', async () => {
    const { port } = fixturePort([loadFixture('auth-login-invalid')]);
    expect(await new GatewaySession(port).signIn('a@b.test', 'pw')).toEqual({ kind: 'rejected' });
  });

  it('423 is locked, and it stays distinguishable from a rejection', async () => {
    const { port } = scriptedPort([{ status: 423, body: { status: 'locked' } }]);
    expect(await new GatewaySession(port).signIn('a@b.test', 'pw')).toEqual({ kind: 'locked' });
  });

  it('⭐ a dead gateway is unreachable, never a rejected password', async () => {
    // FR-014. The failure this prevents: a person resetting a password that was never the problem.
    const { port } = scriptedPort([DEAD]);
    expect(await new GatewaySession(port).signIn('a@b.test', 'pw')).toEqual({ kind: 'unreachable' });
  });

  it('a 200 with no challenge is unreachable — nothing was learnt about the credentials', async () => {
    const { port } = scriptedPort([{ status: 200, body: { status: 'code_sent' } }]);
    expect(await new GatewaySession(port).signIn('a@b.test', 'pw')).toEqual({ kind: 'unreachable' });
  });

  it('a thrown transport error does not escape the boundary', async () => {
    const throwing: HttpPort = async () => {
      throw new Error('fetch exploded with the whole URL in the message');
    };
    expect(await new GatewaySession(throwing).signIn('a@b.test', 'pw')).toEqual({
      kind: 'unreachable',
    });
  });
});

describe('GatewaySession — the code step', () => {
  it('sends the code and the remember-me flag to the SERVER', async () => {
    const { port, calls } = fixturePort([loadFixture('auth-verify-ok')]);
    const outcome = await new GatewaySession(port).submitCode('ch-1', '123456', true);

    expect(outcome).toEqual({ kind: 'ok' });
    expect(calls[0]!.body).toEqual({ challengeId: 'ch-1', code: '123456', rememberMe: true });
  });

  it('the RECORDED 401 is bad_code, with no reason attached', async () => {
    const { port } = fixturePort([loadFixture('auth-verify-invalid')]);
    expect(await new GatewaySession(port).submitCode('ch-1', '000000', false)).toEqual({
      kind: 'bad_code',
    });
  });

  it('a dead gateway during the code step is unreachable', async () => {
    const { port } = scriptedPort([DEAD]);
    expect(await new GatewaySession(port).submitCode('ch-1', '123456', false)).toEqual({
      kind: 'unreachable',
    });
  });
});

describe('GatewaySession — the invitation', () => {
  it('starts with the token and the typed address', async () => {
    const { port, calls } = scriptedPort([
      { status: 200, body: { status: 'code_sent', codeExpiresAt: 1_800_000_600 } },
    ]);
    const outcome = await new GatewaySession(port).startInvite('tok', 'new@b.test');

    expect(outcome).toEqual({ kind: 'code_sent', codeExpiresAt: 1_800_000_600 });
    expect(calls[0]).toEqual({
      path: '/auth/register/start',
      method: 'POST',
      body: { token: 'tok', email: 'new@b.test' },
    });
  });

  it('the RECORDED 401 does not separate a bad token from a wrong address', async () => {
    const { port } = fixturePort([loadFixture('auth-register-start-invalid')]);
    expect(await new GatewaySession(port).startInvite('tok', 'wrong@b.test')).toEqual({
      kind: 'rejected',
    });
  });

  it('completes with the code AND the password together — the API’s order', async () => {
    const { port, calls } = scriptedPort([{ status: 200, body: { status: 'ok' } }]);
    const outcome = await new GatewaySession(port).completeInvite('tok', 'new@b.test', '1234', 'pw');

    expect(outcome).toEqual({ kind: 'ok' });
    expect(calls[0]!.path).toBe('/auth/register/complete');
    expect(calls[0]!.body).toEqual({
      token: 'tok',
      email: 'new@b.test',
      code: '1234',
      password: 'pw',
    });
  });

  it('422 is a weak password and stays separate from a rejection', async () => {
    const { port } = scriptedPort([{ status: 422, body: { status: 'weak_password' } }]);
    expect(await new GatewaySession(port).completeInvite('tok', 'a@b.test', '1', 'x')).toEqual({
      kind: 'weak_password',
    });
  });
});

describe('GatewaySession — signing out', () => {
  it('ends the session on the SERVER, not only in this browser', async () => {
    const { port, calls } = scriptedPort([{ status: 200, body: { status: 'logged_out' } }]);
    const session = new GatewaySession(port);
    await session.signOut();

    expect(calls[0]).toEqual({ path: '/auth/logout', method: 'POST' });
    expect(session.state()).toEqual({ kind: 'anonymous' });
  });

  it('still leaves locally when the call fails — the next resolve finds out the truth', async () => {
    const { port } = scriptedPort([DEAD]);
    const session = new GatewaySession(port);
    await session.signOut();
    expect(session.state()).toEqual({ kind: 'anonymous' });
  });
});
