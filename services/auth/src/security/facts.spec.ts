import { AUTH_SECURITY_FACTS, type AuthFactContext } from './facts.registry';
import { resolveFacts } from './facts.service';

/**
 * ⭐ W32 / 039 (FR-017 · FR-019 · FR-020 · FR-022) — the auth registry, behaviourally.
 *
 * The STRUCTURAL half (every `read` really reads) is `tests/security-posture/facts-are-read.spec.ts`.
 * This half is about what the page ends up SAYING — and the assertion that matters most is negative:
 * the fixed-code row must state a number and not one address, and the proof is made against the
 * serialised output rather than against the one field a reader remembers to check.
 */

const FIXED_ON = {
  DEV_FIXED_LOGIN_CODE: 'ABCD23',
  DEV_FIXED_LOGIN_CODE_EMAILS: 'owner@example.test',
};
const FIXED_OFF = { DEV_FIXED_LOGIN_CODE: '', DEV_FIXED_LOGIN_CODE_EMAILS: '' };

/** A fake scoped client: every reader's query answers a number, so the whole registry resolves. */
function fakeDb(overrides: Record<string, unknown> = {}) {
  const count = jest.fn().mockResolvedValue(0);
  return {
    user: {
      count: jest.fn().mockResolvedValue(2),
      groupBy: jest.fn().mockResolvedValue([{ status: 'active', _count: { _all: 3 } }]),
    },
    apiKey: { count },
    role: {
      findMany: jest.fn().mockResolvedValue([{ key: 'admin', _count: { rolePermissions: 40 } }]),
    },
    userPermissionSet: { count },
    group: { count },
    ...overrides,
  };
}

const ctxWith = (config: AuthFactContext['config'], db = fakeDb()): AuthFactContext =>
  ({ db, config }) as unknown as AuthFactContext;

describe('auth security facts (W32 / 039)', () => {
  it('⭐ the fixed sign-in code is stated ONLY when the deployment actually has it', async () => {
    const off = await resolveFacts(AUTH_SECURITY_FACTS, ctxWith(FIXED_OFF));
    expect(off.find((f) => f.key === 'auth.login.fixed_code')).toBeUndefined();

    const on = await resolveFacts(AUTH_SECURITY_FACTS, ctxWith(FIXED_ON));
    const fact = on.find((f) => f.key === 'auth.login.fixed_code');
    expect(fact).toMatchObject({ severity: 'critical', kind: 'read', state: 'attention' });
    // The COUNT comes from the database read, not from the length of the configured list.
    expect(fact!.value).toContain('2');
  });

  it('⛔ names no address anywhere in what it hands over — asserted on the whole payload', async () => {
    const facts = await resolveFacts(AUTH_SECURITY_FACTS, ctxWith(FIXED_ON));
    const wire = JSON.stringify(facts);
    expect(wire).not.toContain('owner@example.test');
    expect(wire).not.toContain('@');
    // …and not the code either: it is a live credential for the second factor.
    expect(wire).not.toContain('ABCD23');
  });

  it('a fact that cannot be read is `unknown` and STILL SHOWN — never `ok`, never dropped', async () => {
    const broken = fakeDb({ group: { count: jest.fn().mockRejectedValue(new Error('db down')) } });
    const facts = await resolveFacts(AUTH_SECURITY_FACTS, ctxWith(FIXED_OFF, broken));
    const desks = facts.find((f) => f.key === 'auth.desks.without_lead');
    expect(desks?.state).toBe('unknown');
    expect(facts.filter((f) => f.state === 'ok').length).toBeGreaterThan(0);
  });

  it('the built-in fact renders from its constant and carries no reader', () => {
    const builtIn = AUTH_SECURITY_FACTS.filter((f) => f.kind === 'built_in');
    expect(builtIn.length).toBeGreaterThan(0);
    for (const entry of builtIn) {
      expect(entry.read).toBeUndefined();
      expect(entry.value).toBeTruthy();
    }
  });
});
