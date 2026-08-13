import { buildEntry, type AuditEntryInput } from '@crm/common';
import { InviteService } from '../auth/invite.service';
import { ProvisioningService } from './provisioning.service';
import { hashEmployeeId, type ApiKeyFacts } from './provisioning.verify';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §2/§3/§7 — SEC-PV1): what happens AFTER the gate said
 * yes. `provisioning.verify.spec.ts` covers the gate; this file covers the two operations behind it.
 *
 * ── Why the audit fake runs the REAL validator ──────────────────────────────────────────────────
 * A fake that merely records whatever it is handed cannot fail on an entry the product would refuse
 * to write — and that is not hypothetical here: the api-keys block shipped a fingerprint that the
 * detail guard rejected as «a bare number» about once in 220 issuances, under a green suite. So
 * `append` below calls `buildEntry`, which is what refuses an unknown action, a system actor that
 * names no authority, an empty target, and any detail key outside the `staffing` allow-list. The
 * cost is one line; what it buys is that «this call is journalled» is tested against the real
 * catalogue rather than against our own optimism.
 */

const KEY: ApiKeyFacts = {
  id: 'key-1',
  accountId: 'acc-1',
  consumer: 'HR platform',
  fingerprint: 'fp-abc123',
  secretHash: 'argon2-of-the-secret',
  ipAllowList: ['203.0.113.7'],
  ratePerHour: 60,
  active: true,
};

const INSTANCE = '/api/provisioning/v1/staff';

interface FakeUser {
  id: string;
  accountId: string;
  email: string;
  status: string;
  roles: string[];
}

const person = (over: Partial<FakeUser> = {}): FakeUser => ({
  id: 'u-1',
  accountId: 'acc-1',
  email: 'ivan@company.test',
  status: 'active',
  roles: ['agent'],
  ...over,
});

function build(seed: { users?: FakeUser[]; bindings?: Record<string, string> } = {}) {
  const users = seed.users ?? [];
  const bindings = new Map<string, string>(Object.entries(seed.bindings ?? {}));
  const auditEntries: Array<Record<string, unknown>> = [];
  let seq = users.length;

  const repo = {
    userIdForEmployee: jest.fn(async (a: string, hr: string) => bindings.get(`${a}:${hr}`) ?? null),
    bindEmployee: jest.fn(async (a: string, hr: string, u: string) => {
      bindings.set(`${a}:${hr}`, u);
    }),
    // Both reads are account-scoped, exactly as the repository's `findFirst({ account_id, … })` is —
    // a fake that ignored the account could not fail the «somebody else's id» test below.
    findUserById: jest.fn(
      async (a: string, id: string) => users.find((u) => u.accountId === a && u.id === id) ?? null,
    ),
    findUserByEmail: jest.fn(
      async (a: string, email: string) =>
        users.find((u) => u.accountId === a && u.email === email) ?? null,
    ),
    roleKeysOf: jest.fn(async (id: string) => users.find((u) => u.id === id)?.roles ?? []),
    deactivateUser: jest.fn(async (a: string, id: string) => {
      const u = users.find((x) => x.accountId === a && x.id === id);
      if (!u) return false;
      u.status = 'disabled';
      u.roles = []; // the roles go, the record stays (§3)
      return true;
    }),
  };

  const invites = {
    // The machine entrance. It pre-creates the invited user just as the real pipeline's
    // `ensureInvitedUser` does, which is what makes the «found by email right after inviting» branch
    // behave like production rather than like a stub.
    createProvisioningInvitation: jest.fn(async (acc: string, email: string) => {
      if (!users.some((u) => u.accountId === acc && u.email === email)) {
        const id = `u-${++seq}`;
        users.push({ id, accountId: acc, email, status: 'invited', roles: ['newcomer'] });
      }
      return { status: 'created' as const, invitationId: 'inv-1' };
    }),
    // ⚠️ The HUMAN entrance — the one that takes a role key. Reaching it from a machine call is the
    // defect this fake exists to make loud rather than silent.
    createInvitation: jest.fn(async () => {
      throw new Error('the machine path reached the role-taking invite');
    }),
  };

  const refresh = { revokeUserChain: jest.fn(async () => 2) };

  const audit = {
    append: jest.fn(async (accountId: string, input: AuditEntryInput) => {
      auditEntries.push({ accountId, ...buildEntry(input) });
    }),
  };

  const service = new ProvisioningService(
    repo as never,
    invites as never,
    refresh as never,
    audit as never,
  );
  return { service, repo, invites, refresh, auditEntries, users, bindings };
}

const body = (over: Record<string, string> = {}) => ({
  hrEmployeeId: 'E-10422',
  email: 'nova@co.test',
  ...over,
});

const parse = (out: { bodyJson: string }) => JSON.parse(out.bodyJson) as Record<string, unknown>;

describe('create — the three hiring outcomes, none of which is an error at HR (FR-013)', () => {
  it('⭐ a new person ⇒ ONE pending invitation, 202, and the HR id bound to the account it made', async () => {
    const h = build();
    const out = await h.service.create(KEY, body(), INSTANCE);

    expect(out.statusCode).toBe(202);
    expect(parse(out)).toEqual({ outcome: 'invited', invitationSent: true, instance: INSTANCE });
    expect(h.invites.createProvisioningInvitation).toHaveBeenCalledTimes(1);
    // Binding here is what makes the NEXT event about this person unambiguous. Without it the
    // second webhook has to guess again, and guessing is exactly how one human gets two accounts.
    expect(h.bindings.get('acc-1:E-10422')).toBe(h.users[0]!.id);
    expect(h.users).toHaveLength(1);
  });

  it('⭐ a re-hire invites against the EXISTING record — never a second account for one human (§7)', async () => {
    const h = build({
      users: [person({ id: 'u-7', status: 'disabled', roles: [] })],
      bindings: { 'acc-1:E-10422': 'u-7' },
    });
    // HR sends whatever address it holds today; identity is the employee id, so the account is found
    // regardless of what the body says.
    const out = await h.service.create(KEY, body({ email: 'ivan.new@company.test' }), INSTANCE);

    expect(out.statusCode).toBe(202);
    expect(parse(out).outcome).toBe('reactivated');
    // ⚠️ The invitation goes to the STORED address, not the one in the body. Re-pointing an account
    // at whatever an external system sent would turn the machine path into a way to move somebody's
    // login to a new mailbox — an account takeover with a webhook for a weapon.
    expect(h.invites.createProvisioningInvitation).toHaveBeenCalledWith(
      'acc-1',
      'ivan@company.test',
      'api-key:fp-abc123',
    );
    expect(h.users).toHaveLength(1);
    // Found by id ⇒ the email lookup is not even reached; there is nothing to match a twin against.
    expect(h.repo.findUserByEmail).not.toHaveBeenCalled();
  });

  it('somebody already working here ⇒ 200 noop_active — not a 409, not a second invitation', async () => {
    const h = build({ users: [person({ id: 'u-7' })], bindings: { 'acc-1:E-10422': 'u-7' } });
    const out = await h.service.create(KEY, body(), INSTANCE);

    expect(out.statusCode).toBe(200);
    expect(parse(out).outcome).toBe('noop_active');
    expect(h.invites.createProvisioningInvitation).not.toHaveBeenCalled();
  });

  it('a person known only by address gets the HR id bound to them, rather than a twin', async () => {
    const h = build({ users: [person({ id: 'u-7', email: 'nova@co.test' })] });
    const out = await h.service.create(KEY, body(), INSTANCE);

    expect(parse(out).outcome).toBe('noop_active');
    expect(h.bindings.get('acc-1:E-10422')).toBe('u-7');
    expect(h.users).toHaveLength(1);
  });

  it('a body missing the id or the address is malformed — refused before any lookup happens', async () => {
    const h = build();
    const out = await h.service.create(KEY, { hrEmployeeId: 'E-1' }, INSTANCE);

    expect(out.statusCode).toBe(400);
    expect(h.repo.userIdForEmployee).not.toHaveBeenCalled();
  });
});

describe('*** ⭐ SEC-PV1 — the administrator bar holds in BOTH directions ***', () => {
  it.each(['admin', 'super_admin'])(
    'create naming an %s is refused before anything at all is written',
    async (role) => {
      const h = build({ users: [person({ id: 'u-9', email: 'nova@co.test', roles: [role] })] });
      const out = await h.service.create(KEY, body(), INSTANCE);

      expect(out.statusCode).toBe(403);
      expect(out.problemType).toBe('forbidden');
      expect(h.invites.createProvisioningInvitation).not.toHaveBeenCalled();
      expect(h.repo.bindEmployee).not.toHaveBeenCalled();
    },
  );

  it.each(['admin', 'super_admin'])(
    'delete resolving to an %s is refused — the account that could have stopped this is untouchable',
    async (role) => {
      const h = build({
        users: [person({ id: 'u-9', roles: [role] })],
        bindings: { 'acc-1:E-10422': 'u-9' },
      });
      // The half a naive reading of SEC-PV1 leaves out: an HR platform that fires a termination for
      // an administrator's email must not be able to close the account that polices it.
      const out = await h.service.deactivate(KEY, 'E-10422', INSTANCE);

      expect(out.statusCode).toBe(403);
      expect(h.repo.deactivateUser).not.toHaveBeenCalled();
      expect(h.refresh.revokeUserChain).not.toHaveBeenCalled();
      expect(h.users[0]!.status).toBe('active');
    },
  );
});

describe('*** ⭐ SEC-PV1 — the bar is STRUCTURAL: there is no role for a machine to choose ***', () => {
  it('the machine entrance takes (account, address, actor) — and no role at all', () => {
    // Arity is the assertion because the ABSENT ARGUMENT is the guarantee. A check can be reordered,
    // defaulted or forgotten under a deadline; a parameter that does not exist cannot be passed.
    expect(InviteService.prototype.createProvisioningInvitation).toHaveLength(3);
    // Its human sibling does take one — (inviter, email, roleKey) — which is why the two are
    // separate methods rather than one with an optional argument.
    expect(InviteService.prototype.createInvitation).toHaveLength(3);
  });

  it('every create goes through it, and the role-taking entrance is never reached', async () => {
    const h = build();
    await h.service.create(KEY, body(), INSTANCE);

    expect(h.invites.createInvitation).not.toHaveBeenCalled();
    expect(h.invites.createProvisioningInvitation.mock.calls[0]).toEqual([
      'acc-1',
      'nova@co.test',
      'api-key:fp-abc123',
    ]);
  });

  it('a stand with no `newcomer` role refuses rather than falling back to a stronger one', async () => {
    const h = build();
    h.invites.createProvisioningInvitation.mockResolvedValueOnce({ status: 'forbidden' } as never);
    const out = await h.service.create(KEY, body(), INSTANCE);

    expect(out.statusCode).toBe(403);
  });
});

describe('deactivate — close the account, end the sessions, keep the record (FR-014/015/017)', () => {
  it('⭐ status becomes disabled, the role bindings go, and the refresh chain dies with them', async () => {
    const h = build({
      users: [person({ id: 'u-7', roles: ['agent', 'senior'] })],
      bindings: { 'acc-1:E-10422': 'u-7' },
    });
    const out = await h.service.deactivate(KEY, 'E-10422', INSTANCE);

    expect(out.statusCode).toBe(200);
    expect(parse(out).outcome).toBe('deactivated');
    expect(h.repo.deactivateUser).toHaveBeenCalledWith('acc-1', 'u-7');
    expect(h.refresh.revokeUserChain).toHaveBeenCalledWith('u-7');
    // The ROW survives: authorship, the trail and the numbers come back with the person on a re-hire,
    // which is why «delete» from an external system is a deactivation here and never an erasure.
    expect(h.users[0]).toMatchObject({ id: 'u-7', status: 'disabled', roles: [] });
  });

  it('a repeated termination event is a no-op rather than an error, and touches nothing', async () => {
    const h = build({
      users: [person({ id: 'u-7', status: 'disabled', roles: [] })],
      bindings: { 'acc-1:E-10422': 'u-7' },
    });
    const out = await h.service.deactivate(KEY, 'E-10422', INSTANCE);

    expect(out.statusCode).toBe(200);
    expect(parse(out).outcome).toBe('noop_inactive');
    expect(h.repo.deactivateUser).not.toHaveBeenCalled();
    expect(h.refresh.revokeUserChain).not.toHaveBeenCalled();
  });

  it('⭐ an unknown id and SOMEBODY ELSE’S id answer the identical 404 — no existence oracle', async () => {
    const h = build({
      // A mapping this account holds that resolves into another tenant's user: precisely what the
      // second lookup defends against, and the one place a different answer would leak «they exist».
      users: [person({ id: 'u-9', accountId: 'acc-2' })],
      bindings: { 'acc-1:E-OTHER': 'u-9' },
    });
    // The same instance path for both on purpose: the real one echoes the caller's own id back, so
    // comparing the whole rendered answer is the honest test of «these two are indistinguishable».
    const unknown = await h.service.deactivate(KEY, 'E-NOBODY', INSTANCE);
    const foreign = await h.service.deactivate(KEY, 'E-OTHER', INSTANCE);

    expect(unknown.statusCode).toBe(404);
    expect(foreign).toEqual(unknown); // byte for byte — a differing detail is the same oracle
    expect(h.users[0]!.status).toBe('active');
  });
});

describe('the trail — every call recorded, nothing readable in it (FR-018/FR-020, ADR 0043 §5)', () => {
  it('⭐ a refusal is journalled with the fingerprint and the reason CLASS, never a value', async () => {
    const h = build({ users: [person({ id: 'u-9', email: 'nova@co.test', roles: ['admin'] })] });
    await h.service.create(KEY, body(), INSTANCE);

    expect(h.auditEntries).toHaveLength(1);
    expect(h.auditEntries[0]).toMatchObject({
      accountId: 'acc-1',
      actor_kind: 'system',
      actor_ref: 'api-key:fp-abc123',
      action: 'provisioning.rejected',
      target_ref: hashEmployeeId('acc-1', 'E-10422'),
      detail_json: {
        keyFingerprint: 'fp-abc123',
        reasonClass: 'forbidden_role',
        employeeIdHash: hashEmployeeId('acc-1', 'E-10422'),
      },
    });
    // The three things that must never reach a trail: the address, the raw employee number, the body.
    const serialised = JSON.stringify(h.auditEntries);
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('E-10422');
    expect(serialised).not.toContain('nova');
  });

  it('the accepted outcomes are journalled under their own actions, targeted by a salted digest', async () => {
    const h = build({ users: [person({ id: 'u-7' })], bindings: { 'acc-1:E-10422': 'u-7' } });
    await h.service.create(KEY, body(), INSTANCE);
    await h.service.deactivate(KEY, 'E-10422', INSTANCE);

    expect(h.auditEntries.map((e) => e.action)).toEqual([
      'provisioning.create',
      'provisioning.deactivate',
    ]);
    // The outcome is carried as a CLASS, so «what happened» is answerable without a sentence anybody
    // could have typed customer data into.
    const details = h.auditEntries.map((e) => e.detail_json as { reasonClass: string });
    expect(details.map((d) => d.reasonClass)).toEqual(['noop_active', 'deactivated']);
    expect(JSON.stringify(h.auditEntries)).not.toContain('@');
  });

  it('⭐ a refusal that belongs to NO key writes no row — a stranger’s traffic is not a tenant’s trail', async () => {
    const h = build();
    const out = await h.service.refuse('', null, 'unknown_key', INSTANCE);

    // Still a rendered, uniform refusal for the caller — the edge's own logs carry the count.
    expect(out.statusCode).toBe(401);
    expect(out.outcome).toBe('refused');
    expect(h.auditEntries).toEqual([]);
  });
});
