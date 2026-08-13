import { of, throwError } from 'rxjs';
import { Metadata } from '@grpc/grpc-js';
import { EnsureOperatorProfile } from './ensure-operator-profile';
import { RegistrationController } from './registration.controller';
import { AuthController } from './auth.controller';

/**
 * MVP block W1 / roadmap 5.10 — registration left no operator profile, so an invited AM was
 * unassignable while every seeded user worked.
 *
 * The point's *Done when* asks for the two halves to be JOINED and for the join to be exercised in
 * the order that fails today: **invite → register → assign**. The middle step is what these cover —
 * that completing a registration reaches `users`, with the caller's own proven identity and nobody
 * else's, and that a failure there cannot cost the person their session.
 */

const SECRET = 'test-secret-not-a-real-one';

/** Minimal stand-ins for the two collaborators the helper needs. */
const jwtOk = {
  verify: (token: string) => {
    if (token !== 'fresh-access') throw new Error('bad token');
    return { sub: 'user-77', account_id: 'acc-9' };
  },
};
const cfg = { JWT_SECRET: SECRET } as never;

function harness(behaviour: 'ok' | 'boom' | 'slow' = 'ok') {
  const calls: Array<{ data: unknown; md?: Metadata }> = [];
  const client = {
    getService: () => ({
      ensureOwnOperator: (data: unknown, md?: Metadata) => {
        calls.push({ data, md });
        if (behaviour === 'boom') return throwError(() => new Error('users is down'));
        return of({ operatorId: 'op-1', accountId: 'acc-9', active: true });
      },
    }),
  } as never;
  return { calls, helper: new EnsureOperatorProfile(client, jwtOk as never, cfg) };
}

describe('EnsureOperatorProfile (the gateway half of roadmap 5.10)', () => {
  it('sends the caller context taken from the freshly minted token — never from a request body', async () => {
    const { calls, helper } = harness();

    const id = await helper.fromAccessToken('fresh-access');

    expect(id).toBe('op-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.md?.get('x-actor-account-id')[0]).toBe('acc-9');
    expect(calls[0]!.md?.get('x-actor-user-id')[0]).toBe('user-77');
    // The request itself carries nothing — the subject is not expressible on the wire.
    expect(calls[0]!.data).toEqual({});
  });

  it('a dead users service does NOT throw — the session is already valid and the next login retries', async () => {
    const { helper } = harness('boom');
    await expect(helper.fromAccessToken('fresh-access')).resolves.toBeUndefined();
  });

  it('an unverifiable token is skipped rather than trusted', async () => {
    const { calls, helper } = harness();
    await expect(helper.fromAccessToken('forged')).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('no token at all is a no-op', async () => {
    const { calls, helper } = harness();
    await expect(helper.fromAccessToken(undefined)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('the two call sites are wired (the defect was that neither existed)', () => {
  const pair = {
    accessToken: 'fresh-access',
    refreshToken: 'r',
    accessExpiresAt: `${Math.floor(Date.now() / 1000) + 900}`,
    refreshExpiresAt: `${Math.floor(Date.now() / 1000) + 86400}`,
  };
  const res = () =>
    ({
      cookie: () => undefined,
      clearCookie: () => undefined,
      status: () => undefined,
    }) as never;

  it('⭐ completing a registration ensures the profile — the sequence invite → register → assign', async () => {
    let ensured: string | undefined;
    const ctrl = new RegistrationController(
      { getService: () => ({ completeRegistration: () => of(pair) }) } as never,
      { COOKIE_SECURE: false } as never,
      {
        fromAccessToken: async (t: string) => {
          ensured = t;
          return 'op-1';
        },
      } as never,
    );
    ctrl.onModuleInit();

    const out = await ctrl.complete(
      { token: 't', email: 'a@b.test', code: '123456', password: 'Aa1!aaa' },
      res(),
    );

    expect(out).toEqual({ status: 'ok' });
    // Awaited before the response returns: a person invited as an AM is assignable immediately.
    expect(ensured).toBe('fresh-access');
  });

  it('signing in ensures it too — the repair path for people who registered before this shipped', async () => {
    let ensured: string | undefined;
    const ctrl = new AuthController(
      { getService: () => ({ verifyLoginCode: () => of(pair) }) } as never,
      { COOKIE_SECURE: false } as never,
      {
        fromAccessToken: async (t: string) => {
          ensured = t;
          return 'op-1';
        },
      } as never,
    );
    ctrl.onModuleInit();

    const out = await ctrl.verify({ challengeId: 'c', code: '123456' }, res());

    expect(out).toEqual({ status: 'ok' });
    expect(ensured).toBe('fresh-access');
  });

  it('a refused sign-in ensures NOTHING — no profile for a session that was never granted', async () => {
    let called = false;
    const ctrl = new AuthController(
      { getService: () => ({ verifyLoginCode: () => throwError(() => new Error('bad code')) }) } as never,
      { COOKIE_SECURE: false } as never,
      {
        fromAccessToken: async () => {
          called = true;
          return undefined;
        },
      } as never,
    );
    ctrl.onModuleInit();

    const out = await ctrl.verify({ challengeId: 'c', code: '000000' }, res());

    expect(out).toEqual({ status: 'invalid_code' });
    expect(called).toBe(false);
  });
});
