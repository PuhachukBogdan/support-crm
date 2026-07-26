import { of, throwError } from 'rxjs';
import { type ClientGrpc } from '@nestjs/microservices';
import { AuthorAuthorityClient, AuthorityUnavailableError } from './auth.client';

/**
 * T013 (feature 014) — the author-authority client. FAILS before the client exists, PASSES after.
 *
 * The property under test is FR-024, and it is subtle enough to deserve its own spec: an
 * **unavailable** authority and an **empty** authority must not collapse into the same value. Both
 * end in the rule being refused, but only one of them is a decision — if a transport failure were
 * silently mapped to `[]`, then "auth is down" would look exactly like "this author holds nothing",
 * and a later change treating an empty set as "no restriction" would fail OPEN. So the boundary is
 * enforced here, at the seam, rather than trusted downstream.
 */
function make(resolveEffectivePermissions: jest.Mock) {
  const client = { getService: () => ({ resolveEffectivePermissions }) } as unknown as ClientGrpc;
  const c = new AuthorAuthorityClient(client);
  c.onModuleInit();
  return c;
}

describe('AuthorAuthorityClient.resolve', () => {
  it('returns the permission set exactly as auth gave it', async () => {
    const rpc = jest
      .fn()
      .mockReturnValue(of({ roleKey: 'teamlead', permissionKeys: ['crm.labels.manage', 'a.b'] }));
    await expect(make(rpc).resolve('acc-1', 'u-1')).resolves.toEqual({
      roleKey: 'teamlead',
      permissionKeys: ['crm.labels.manage', 'a.b'],
    });
    expect(rpc).toHaveBeenCalledWith({ accountId: 'acc-1', userId: 'u-1', previewRole: '' });
  });

  // An author who currently holds nothing is a legitimate answer — the engine turns it into a
  // per-action refusal. It must NOT be conflated with a failure.
  it('treats an empty permission list as a valid answer, not a failure', async () => {
    const rpc = jest.fn().mockReturnValue(of({ roleKey: 'support_agent', permissionKeys: [] }));
    await expect(make(rpc).resolve('acc-1', 'u-1')).resolves.toEqual({
      roleKey: 'support_agent',
      permissionKeys: [],
    });
  });

  it('THROWS when auth is unreachable — never an empty set (FR-024 fail-closed)', async () => {
    const rpc = jest.fn().mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    const err = await make(rpc)
      .resolve('acc-1', 'u-1')
      .catch((e) => e);
    expect(err).toBeInstanceOf(AuthorityUnavailableError);
  });

  it('THROWS on an unreadable response rather than assuming anything', async () => {
    for (const body of [{}, { permissionKeys: 'not-an-array' }, { permissionKeys: null }, null]) {
      const rpc = jest.fn().mockReturnValue(of(body));
      await expect(make(rpc).resolve('acc-1', 'u-1')).rejects.toBeInstanceOf(
        AuthorityUnavailableError,
      );
    }
  });

  it('THROWS on a missing author identity (an authorless rule must refuse, not run)', async () => {
    const rpc = jest.fn().mockReturnValue(of({ permissionKeys: [] }));
    await expect(make(rpc).resolve('acc-1', '')).rejects.toBeInstanceOf(AuthorityUnavailableError);
    await expect(make(rpc).resolve('', 'u-1')).rejects.toBeInstanceOf(AuthorityUnavailableError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('never leaks ids or transport detail into the error message (Principle IV)', async () => {
    const rpc = jest
      .fn()
      .mockReturnValue(
        throwError(() => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:50051'), {})),
      );
    const err = (await make(rpc)
      .resolve('acc-secret', 'u-secret')
      .catch((e) => e)) as AuthorityUnavailableError;
    expect(err.message).not.toContain('acc-secret');
    expect(err.message).not.toContain('u-secret');
    expect(err.message).not.toContain('10.0.0.5');
  });
});
