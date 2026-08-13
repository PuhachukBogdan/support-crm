import { randomBytes, randomUUID } from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import { JwtService } from '@nestjs/jwt';
import { RpcException } from '@nestjs/microservices';
import { parseDetail } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { FixedClock } from '../auth/ports/clock';
import { TokenService } from '../auth/token.service';
import { makeAuthConfig } from '../../tests/support/auth-test-doubles';
import { ApiKeysRepository, type ApiKeyRow } from './api-keys.repository';
import { ApiKeysService, fingerprintOf } from './api-keys.service';
import { ApiKeysGrpcController } from './api-keys.grpc.controller';

/**
 * ⭐ W31 / feature 038 (roadmap 3.17) — the API key's lifecycle. **The block's invariant here is
 * SEC-PV1**: the value exists for one response and nowhere else, and a key of one account is
 * unreachable from another.
 *
 * ── Why this fake is not the shared one ──────────────────────────────────────────────────────────
 * `auth-test-doubles`' `forAccount` returns itself — it IS single-account, so it cannot fail an
 * isolation test, which is the one thing this feature most needs proven. This fake scopes for real
 * and, more importantly, **enforces the partial unique index** (`one active key per consumer`) that
 * Prisma cannot express: a rotation that created before it revoked would throw here, exactly as
 * Postgres would. A fake that answers whatever it is told cannot fail on an ordering defect, and
 * ordering is the whole hazard in `rotate`.
 */

/** A lazily-run statement, the shape `$transaction([...])` takes. Order of execution = array order. */
function statement<T>(run: () => T) {
  return {
    then(resolve?: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      try {
        const value = run();
        return Promise.resolve(resolve ? resolve(value) : value);
      } catch (err) {
        if (reject) return Promise.resolve(reject(err));
        return Promise.reject(err);
      }
    },
  };
}

const clone = (r: ApiKeyRow): ApiKeyRow => ({ ...r, ip_allow_list: [...r.ip_allow_list] });

function makeFake() {
  const keys: ApiKeyRow[] = [];
  const auditEntries: Array<Record<string, unknown>> = [];
  let seq = 0;

  const scopedFor = (accountId: string) => ({
    apiKey: {
      findMany: async () =>
        keys
          .filter((k) => k.account_id === accountId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .map(clone),
      findFirst: async ({ where }: { where: { id: string } }) => {
        const hit = keys.find((k) => k.account_id === accountId && k.id === where.id);
        return hit ? clone(hit) : null;
      },
      create: ({ data }: { data: Record<string, unknown> }) =>
        statement(() => {
          const row = {
            account_id: accountId,
            active: true,
            last_used_at: null,
            created_at: new Date(1_700_000_000_000 + ++seq),
            updated_at: new Date(1_700_000_000_000 + seq),
            ...data,
          } as unknown as ApiKeyRow;
          // The partial unique index, in the fake. Rotation must revoke BEFORE it creates.
          if (
            keys.some(
              (k) => k.account_id === row.account_id && k.consumer === row.consumer && k.active,
            )
          ) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          keys.push(row);
          return clone(row);
        }),
      updateMany: ({
        where,
        data,
      }: {
        where: { id?: string; active?: boolean };
        data: Record<string, unknown>;
      }) =>
        statement(() => {
          let count = 0;
          for (const k of keys) {
            if (k.account_id !== accountId) continue;
            if (where.id !== undefined && k.id !== where.id) continue;
            if (where.active !== undefined && k.active !== where.active) continue;
            Object.assign(k, data);
            count++;
          }
          return { count };
        }),
    },
    auditEntry: {
      create: ({ data }: { data: Record<string, unknown> }) =>
        statement(() => {
          auditEntries.push({ ...data });
          return {};
        }),
    },
    $transaction: async (list: unknown[]) => Promise.all(list as Promise<unknown>[]),
  });

  const prisma = {
    forAccount: (accountId: string) => scopedFor(accountId),
    // The account-free half — the verification read and `last_used_at` (see the repository banner).
    apiKey: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const hit = keys.find((k) => k.id === where.id);
        return hit ? clone(hit) : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const k of keys) {
          if (k.id !== where.id) continue;
          Object.assign(k, data);
          count++;
        }
        return { count };
      },
    },
  };

  return { prisma: prisma as unknown as PrismaService, keys, auditEntries };
}

function build() {
  const fake = makeFake();
  const tokens = new TokenService(
    makeAuthConfig(),
    new FixedClock(),
    fake.prisma,
    new JwtService({}),
  );
  const service = new ApiKeysService(
    new ApiKeysRepository(fake.prisma),
    tokens,
    new AuditRepository(fake.prisma),
    new FixedClock(new Date('2026-08-13T10:00:00.000Z')),
  );
  return { ...fake, service, controller: new ApiKeysGrpcController(service) };
}

const ADMIN_PERMS = ['users.list.view', 'platform.settings.manage'];

function md(accountId = 'acct-A', permissions = ADMIN_PERMS): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', permissions.join(','));
  return m;
}

/** `<id>.<secret>` → the two halves the machine path sends in separate headers. */
const split = (value: string): [string, string] => {
  const at = value.indexOf('.');
  return [value.slice(0, at), value.slice(at + 1)];
};

const issueOk = async (service: ApiKeysService, accountId = 'acct-A', consumer = 'HR platform') => {
  const outcome = await service.issue(accountId, 'u-admin', {
    consumer,
    ipAllowList: ['203.0.113.7'],
  });
  if (outcome.status !== 'ok') throw new Error(`issue refused: ${outcome.status}`);
  return outcome.issued;
};

describe('issuance shows the value once and stores only a hash (FR-001)', () => {
  it('⭐ returns `<id>.<secret>` and keeps nothing but an argon2id digest at rest', async () => {
    const { service, keys } = build();
    const issued = await issueOk(service);
    const [id, secret] = split(issued.value);

    expect(id).toBe(issued.key.id);
    expect(secret).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, the invite-token shape
    expect(keys).toHaveLength(1);
    expect(keys[0]!.secret_hash).toMatch(/^\$argon2id\$/);
    // The stored row cannot be turned back into the value: no column holds it, hash included.
    expect(JSON.stringify(keys[0])).not.toContain(secret);
    // ⚠️ The `fp_` prefix is asserted on purpose: without it the audit detail layer refuses an
    // all-digit digest as personal data, which is one issuance in ~220 (see `fingerprintOf`).
    expect(keys[0]!.fingerprint).toMatch(/^fp_[0-9a-f]{12}$/);
    expect(keys[0]!.fingerprint).not.toContain(secret.slice(0, 12));
  });

  it('the value is never obtainable again — the read-back and the list carry no such field', async () => {
    const { service, controller } = build();
    const issued = await issueOk(service);
    const [, secret] = split(issued.value);

    const listed = await controller.listApiKeys({}, md());
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(Object.keys(listed.keys[0]!).sort()).toEqual(
      [
        'active',
        'consumer',
        'createdAt',
        'fingerprint',
        'id',
        'ipAllowList',
        'lastUsedAt',
        'ratePerHour',
        'rotatedFromId',
      ].sort(),
    );
    expect(listed.keys[0]!.fingerprint).toBe(issued.key.fingerprint);
  });

  it('an empty allow-list and a zero rate are stored as themselves — deny-everything, server default', async () => {
    const { service, keys } = build();
    const outcome = await service.issue('acct-A', 'u-admin', { consumer: 'HR platform' });
    expect(outcome.status).toBe('ok');
    // ⚠️ EMPTY = DENY (fail-closed). The absence of a decision is refusal, not permission.
    expect(keys[0]!.ip_allow_list).toEqual([]);
    expect(keys[0]!.rate_per_hour).toBe(60);
  });
});

describe('the fingerprint is always writable into the journal', () => {
  it('⭐ REGRESSION: no digest is ever refused as «a bare number» by the detail guard', () => {
    // The defect this pins is a random one: a 12-hex digest is all digits about once in 220, and the
    // audit detail layer refuses an all-digit value as personal data — so ~0.5% of issuances would
    // have failed, at random, with a green suite. 2 000 draws makes an unprefixed digest a ~0.01%
    // false pass. The structural half is the assertion above it: the prefix always carries a letter.
    for (let i = 0; i < 2_000; i++) {
      const fingerprint = fingerprintOf(randomUUID(), randomBytes(32).toString('hex'));
      expect(fingerprint.startsWith('fp_')).toBe(true);
      expect(() => parseDetail('api_key.issued', { keyFingerprint: fingerprint })).not.toThrow();
    }
  });
});

describe('verification accepts what was issued and nothing else (FR-002 / FR-009)', () => {
  it('⭐ the issued value verifies; a forged secret and an unknown id do not', async () => {
    const { service } = build();
    const issued = await issueOk(service);
    const [id, secret] = split(issued.value);

    await expect(service.verify(id, secret)).resolves.toMatchObject({ ok: true });

    /**
     * ⚠️ **THE FORGERY MUST BE GUARANTEED TO DIFFER, and the first version was not.**
     *
     * It replaced the last character with `'0'` — and the secret is `randomBytes(32).toString('hex')`,
     * so **one issuance in sixteen already ends in `'0'`**. In those runs the "forged" value WAS the real
     * secret, verification correctly answered `ok: true`, and the test failed while the product was
     * right. It failed for the first time in CI on 2026-08-13 — the first CI run after 130 commits — and
     * it had been a 6 % coin flip on every run since W31.
     *
     * ⓘ The sibling test twelve lines up (`no digest is ever refused as «a bare number»`) documents
     * exactly this class at 1-in-220 and draws 2 000 samples to pin it. The same reasoning was needed one
     * assertion below it and was not applied: **a random value mutated at one position is not a different
     * value.** Flipping to a character that cannot be the original one removes the dice entirely.
     */
    const forged = `${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`;
    // The construction's own invariant, asserted rather than assumed — so a later edit that reintroduces
    // the coin flip fails HERE, with a message that says what is wrong, instead of once every sixteen runs.
    expect(forged).not.toBe(secret);
    expect(forged).toHaveLength(secret.length);

    await expect(service.verify(id, forged)).resolves.toEqual({
      ok: false,
      reason: 'mismatch',
    });
    await expect(service.verify('7b6f5e4d-0000-4000-8000-000000000000', secret)).resolves.toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('`last_used_at` is written only when told — a refusal must not make a dead key look alive', async () => {
    const { service, keys } = build();
    const issued = await issueOk(service);
    const [id, secret] = split(issued.value);

    await service.verify(id, secret);
    expect(keys[0]!.last_used_at).toBeNull();
    await service.markUsed(id);
    expect(keys[0]!.last_used_at).toEqual(new Date('2026-08-13T10:00:00.000Z'));
  });
});

describe('rotation replaces a live key without ever having two (FR-003)', () => {
  it('⭐ the predecessor is revoked, the lineage is linked, and the unique index is never violated', async () => {
    const { service, keys } = build();
    const first = await issueOk(service);
    const [oldId, oldSecret] = split(first.value);

    const rotated = await service.rotate('acct-A', 'u-admin', oldId);
    expect(rotated.status).toBe('ok');
    if (rotated.status !== 'ok') return;
    const [newId, newSecret] = split(rotated.issued.value);

    expect(newId).not.toBe(oldId);
    expect(rotated.issued.value).not.toBe(first.value);
    // Two rows, one consumer, exactly one alive — the fake throws P2002 if the order ever slips.
    expect(keys).toHaveLength(2);
    expect(keys.filter((k) => k.active)).toHaveLength(1);
    expect(keys.find((k) => k.id === oldId)!.active).toBe(false);
    expect(keys.find((k) => k.id === newId)!.rotated_from_id).toBe(oldId);
    expect(keys.find((k) => k.id === newId)!.consumer).toBe('HR platform');

    // The old value stops working the moment the new one is shown; the new one works.
    await expect(service.verify(oldId, oldSecret)).resolves.toEqual({
      ok: false,
      reason: 'revoked_key',
    });
    await expect(service.verify(newId, newSecret)).resolves.toMatchObject({ ok: true });
  });

  it('a second live key for the same consumer is refused, not silently created', async () => {
    const { service } = build();
    await issueOk(service);
    await expect(service.issue('acct-A', 'u-admin', { consumer: 'HR platform' })).resolves.toEqual({
      status: 'consumer_taken',
    });
  });
});

describe('revocation is immediate and repeatable (FR-003)', () => {
  it('⭐ the next call is refused, and a repeat is a no-op rather than an error', async () => {
    const { service, controller } = build();
    const issued = await issueOk(service);
    const [id, secret] = split(issued.value);

    const first = await controller.revokeApiKey({ keyId: id }, md());
    expect(first).toEqual({ revoked: true });
    await expect(service.verify(id, secret)).resolves.toEqual({ ok: false, reason: 'revoked_key' });

    const again = await controller.revokeApiKey({ keyId: id }, md());
    expect(again).toEqual({ revoked: false });
  });

  it('rotating a revoked key is refused — re-arming a consumer is an issuance, and says so', async () => {
    const { service } = build();
    const issued = await issueOk(service);
    const [id] = split(issued.value);
    await service.revoke('acct-A', 'u-admin', id);
    await expect(service.rotate('acct-A', 'u-admin', id)).resolves.toEqual({
      status: 'already_revoked',
    });
  });
});

describe('the journal (FR-005)', () => {
  it('⭐ three acts, three entries — each carrying a fingerprint and no value anywhere', async () => {
    const { service, auditEntries } = build();
    const first = await issueOk(service);
    const [oldId, oldSecret] = split(first.value);
    const rotated = await service.rotate('acct-A', 'u-admin', oldId);
    if (rotated.status !== 'ok') throw new Error('rotate refused');
    const [newId, newSecret] = split(rotated.issued.value);
    await service.revoke('acct-A', 'u-admin', newId);

    expect(auditEntries.map((e) => e.action)).toEqual([
      'api_key.issued',
      // ⚠️ ONE entry for a rotation, not a revoke plus an issue: «when did this consumer's
      // credential change» must not be answerable with «twice».
      'api_key.rotated',
      'api_key.revoked',
    ]);
    for (const entry of auditEntries) {
      expect(entry.actor_user_id).toBe('u-admin');
      expect((entry.detail_json as { keyFingerprint?: string }).keyFingerprint).toMatch(
        /^fp_[0-9a-f]{12}$/,
      );
    }
    expect(auditEntries[0]!.target_ref).toBe(oldId);
    expect(auditEntries[1]!.target_ref).toBe(newId); // the successor: its row names the predecessor
    const serialised = JSON.stringify(auditEntries);
    expect(serialised).not.toContain(oldSecret);
    expect(serialised).not.toContain(newSecret);
  });
});

describe('a key belongs to ONE account (FR-019, Principle I)', () => {
  it("⭐ account B cannot see, rotate or revoke account A's key — even holding its id", async () => {
    const { service, controller, keys } = build();
    const issued = await issueOk(service, 'acct-A');
    const id = issued.key.id;

    const theirs = await controller.listApiKeys({}, md('acct-B'));
    expect(theirs.keys).toEqual([]);
    await expect(controller.revokeApiKey({ keyId: id }, md('acct-B'))).rejects.toThrow(RpcException);
    await expect(controller.rotateApiKey({ keyId: id }, md('acct-B'))).rejects.toThrow(RpcException);
    // Nothing moved: the key is still alive and still account A's.
    expect(keys).toHaveLength(1);
    expect(keys[0]!.active).toBe(true);
    expect(keys[0]!.account_id).toBe('acct-A');
  });

  it('fails closed with no account context at all', async () => {
    const { controller } = build();
    const bare = new Metadata();
    bare.set('x-actor-permissions', ADMIN_PERMS.join(','));
    await expect(controller.listApiKeys({}, bare)).rejects.toThrow(RpcException);
  });
});

describe('the wire refuses what it cannot store', () => {
  it('a blank consumer is INVALID_ARGUMENT, and nothing is written', async () => {
    const { controller, keys, auditEntries } = build();
    await expect(controller.issueApiKey({ consumer: '   ' }, md())).rejects.toThrow(RpcException);
    expect(keys).toEqual([]);
    expect(auditEntries).toEqual([]);
  });

  it('an unknown key id is NOT_FOUND on both mutations', async () => {
    const { controller } = build();
    await expect(controller.revokeApiKey({ keyId: 'nope' }, md())).rejects.toThrow(RpcException);
    await expect(controller.rotateApiKey({ keyId: 'nope' }, md())).rejects.toThrow(RpcException);
  });
});
