import { computeDigest } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { ProvisioningController } from './provisioning.grpc.controller';
import { ProvisioningRepository } from './provisioning.repository';
import {
  hashBody,
  REFUSAL_STATUS,
  REFUSAL_TYPE,
  type ApiKeyFacts,
  type ProvisioningRefusal,
} from './provisioning.verify';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §6 — FR-007): verify → claim → act → settle.
 *
 * ── Why the REAL repository sits under these tests ──────────────────────────────────────────────
 * The claim is the one place in this feature where being right depends on the ORDER of two
 * statements: a `select`-then-`insert` reads identically to an `insert`-first claim in every test
 * that runs one call at a time, and differs on exactly the traffic this endpoint is built for — two
 * retries of one webhook arriving in the same second, which is what a retry IS. So the fake here is
 * a Prisma stand-in that ENFORCES the unique index and records the order it was asked in; the
 * repository under test is the real one. A fake ledger with a `claim()` of its own could not fail.
 *
 * The service above it IS faked, and deliberately: this file asks «was the work done, and how many
 * times», never «what did the work do» — that is `provisioning.service.spec.ts`.
 */

const SECRET = 'a'.repeat(64);
const NOW = 1_760_000_000;

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

const CREATE_BODY = JSON.stringify({ hrEmployeeId: 'E-10422', email: 'nova@company.test' });
const sign = (raw: string) => `t=${NOW},v1=${computeDigest(SECRET, NOW, raw)}`;

const call = (over: Record<string, unknown> = {}) => {
  const rawBody = (over.rawBody as string | undefined) ?? CREATE_BODY;
  return {
    keyId: 'key-1',
    keySecret: SECRET,
    rawBody,
    signatureHeader: sign(rawBody),
    clientIp: '203.0.113.7',
    idempotencyKey: 'idem-1',
    receivedAt: NOW,
    ...over,
  };
};

const CREATED = {
  statusCode: 202,
  problemType: '',
  outcome: 'invited',
  bodyJson: JSON.stringify({ outcome: 'invited', invitationSent: true }),
};
const CLOSED = {
  statusCode: 200,
  problemType: '',
  outcome: 'deactivated',
  bodyJson: JSON.stringify({ outcome: 'deactivated' }),
};

function build() {
  const rows: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let recentCalls = 0;
  let seq = 0;

  const prisma = {
    provisioningRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push('create');
        // The unique index `(api_key_id, idempotency_key)`, in the fake. Without it the loser of a
        // race has nothing to lose to, and the whole insert-first design is untestable.
        if (
          rows.some(
            (r) => r.api_key_id === data.api_key_id && r.idempotency_key === data.idempotency_key,
          )
        ) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `req-${++seq}`, created_at: new Date(), ...data };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, string> }) => {
        calls.push('findFirst');
        return (
          rows.find(
            (r) => r.api_key_id === where.api_key_id && r.idempotency_key === where.idempotency_key,
          ) ?? null
        );
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push('update');
        const row = rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      },
      count: async () => recentCalls,
    },
  };

  const service = {
    create: jest.fn(async () => CREATED),
    deactivate: jest.fn(async () => CLOSED),
    refuse: jest.fn(async (_acc: string, _key: unknown, refusal: ProvisioningRefusal) => ({
      statusCode: REFUSAL_STATUS[refusal],
      problemType: REFUSAL_TYPE[refusal],
      outcome: 'refused',
      bodyJson: JSON.stringify({ status: REFUSAL_STATUS[refusal] }),
    })),
  };

  const keys = {
    factsFor: jest.fn(async () => KEY),
    verifySecret: jest.fn(async (_hash: string, secret: string) => secret === SECRET),
    markUsed: jest.fn(async () => undefined),
  };

  const repo = new ProvisioningRepository(prisma as unknown as PrismaService);
  const controller = new ProvisioningController(service as never, repo, keys as never);
  return {
    controller,
    repo,
    service,
    keys,
    rows,
    calls,
    setRecentCalls: (n: number) => {
      recentCalls = n;
    },
  };
}

describe('*** ⭐ one idempotency key, one effect (FR-007) ***', () => {
  it('the same key and the same body ⇒ the FIRST answer verbatim, and the work happens once', async () => {
    const h = build();
    const first = await h.controller.provisionStaff(call());
    const second = await h.controller.provisionStaff(call());

    expect(first.statusCode).toBe(202);
    // ⚠️ Including the STATUS. A retry handed a fresh answer would make «same result, no second side
    // effect» half true — no second effect, but a different story, which is how a caller ends up
    // believing two different things happened.
    expect(second).toEqual(first);
    expect(h.service.create).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(1);
    // The ledger holds what was ANSWERED, not a placeholder: that is what a replay reads back.
    expect(h.rows[0]).toMatchObject({ status_code: 202, outcome: 'invited', operation: 'create' });
    // Both calls were authentic, so both count as the key being alive.
    expect(h.keys.markUsed).toHaveBeenCalledTimes(2);
  });

  it('the same key with a DIFFERENT body ⇒ 409 — a reused key never silently applies new content', async () => {
    const h = build();
    await h.controller.provisionStaff(call());
    const other = await h.controller.provisionStaff(
      call({ rawBody: JSON.stringify({ hrEmployeeId: 'E-99', email: 'other@company.test' }) }),
    );

    expect(other.statusCode).toBe(409);
    expect(other.problemType).toBe('idempotency-conflict');
    expect(other.outcome).toBe('refused');
    expect(h.service.create).toHaveBeenCalledTimes(1);
    expect(h.rows).toHaveLength(1); // the second intent left nothing behind to be replayed later
  });

  it('⭐ the claim is INSERT-first: the loser of a P2002 reads the winner’s stored answer', async () => {
    const h = build();
    await h.controller.provisionStaff(call());
    h.calls.length = 0;
    const replayed = await h.controller.provisionStaff(call());

    // The ORDER is the property. A select-then-insert would read first — and both retries of one
    // webhook pass that read before either of them writes. Here the index decides and the loser
    // resolves the collision by reading, which is the only sequence that cannot double-apply.
    expect(h.calls).toEqual(['create', 'findFirst']);
    expect(replayed.outcome).toBe('invited');
  });

  it('a claim still IN FLIGHT is 409 — we do not answer «done» for work that has not finished', async () => {
    const h = build();
    // A concurrent first call that has claimed and not yet settled: the row exists, its answer does
    // not. Replaying it would report a completed hire that may still fail.
    await h.repo.claim({
      accountId: 'acc-1',
      apiKeyId: 'key-1',
      idempotencyKey: 'idem-1',
      operation: 'create',
      bodyHash: hashBody(CREATE_BODY),
    });
    const out = await h.controller.provisionStaff(call());

    expect(out.statusCode).toBe(409);
    expect(h.service.create).not.toHaveBeenCalled();
  });

  it('the two operations keep their own ledger rows and their own instance path', async () => {
    const h = build();
    const out = await h.controller.deactivateStaff(
      call({ rawBody: '{}', hrEmployeeId: 'E-10422', idempotencyKey: 'idem-2' }),
    );

    expect(out.statusCode).toBe(200);
    expect(h.service.deactivate).toHaveBeenCalledWith(
      KEY,
      'E-10422',
      '/api/provisioning/v1/staff/E-10422',
    );
    expect(h.rows[0]).toMatchObject({ operation: 'deactivate', outcome: 'deactivated' });
  });

  it('⭐ the work is done from the SIGNED bytes, never from a field the edge decoded beside them', async () => {
    const h = build();
    // The wire carries a second, unsigned `hrEmployeeId`. If create read it, the thing signed and the
    // thing applied would be two different objects and only one of them was signed.
    await h.controller.provisionStaff(call({ hrEmployeeId: 'E-SMUGGLED' }));

    expect(h.service.create).toHaveBeenCalledWith(
      KEY,
      { hrEmployeeId: 'E-10422', email: 'nova@company.test' },
      '/api/provisioning/v1/staff',
    );
  });
});

describe('*** ⭐ a refused call leaves no claim behind and no proof of life ***', () => {
  it('over the hourly cap ⇒ 429, no ledger row, and the key is not stamped as used', async () => {
    const h = build();
    h.setRecentCalls(60);
    const out = await h.controller.provisionStaff(call());

    expect(out.statusCode).toBe(429);
    expect(h.rows).toEqual([]); // nothing claimed ⇒ the idempotency key is still the caller's to use
    // A refusal must never make a dead or throttled key look alive on the keys screen.
    expect(h.keys.markUsed).not.toHaveBeenCalled();
    expect(h.service.create).not.toHaveBeenCalled();
  });

  it('the same idempotency key still works once the cap clears', async () => {
    const h = build();
    h.setRecentCalls(60);
    await h.controller.provisionStaff(call());
    h.setRecentCalls(0);
    const out = await h.controller.provisionStaff(call());

    // The consequence of the row above never being written: a throttled caller retries normally
    // instead of being locked out of its own key for ever.
    expect(out.statusCode).toBe(202);
    expect(h.rows).toHaveLength(1);
  });

  it('an unauthentic call is refused with no claim either — and the refusal is audited by the service', async () => {
    const h = build();
    const out = await h.controller.provisionStaff(call({ keySecret: 'b'.repeat(64) }));

    expect(out.statusCode).toBe(401);
    expect(h.rows).toEqual([]);
    expect(h.service.refuse).toHaveBeenCalledTimes(1);
    expect(h.keys.markUsed).not.toHaveBeenCalled();
  });
});
