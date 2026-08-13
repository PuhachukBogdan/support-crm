import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { DETAIL_KEYS, buildEntry, classOf, parseDetail } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { DeniedAddressRepository, type DeniedAddressRow } from './denied-address.repository';
import { DeniedAddressService } from './denied-address.service';
import {
  DeniedAddressEdgeController,
  DeniedAddressGrpcController,
} from './denied-address.grpc.controller';

/**
 * ⭐ W32 / feature 039 (roadmap 12.10) — the deny-list an administrator manages.
 *
 * ── Why this fake is not the shared one ──────────────────────────────────────────────────────────
 * It does two things `auth-test-doubles` cannot. It **scopes for real** (that double's `forAccount`
 * returns itself, so it is single-account and cannot fail an isolation test), and it **enforces the
 * `(account_id, address)` unique index plus a real ROLLBACK** — without which "a repeat is a quiet
 * success that writes neither a second row nor a second journal entry" cannot be proven at all: the
 * collision would be absorbed by a fake that never had a constraint to violate.
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

const clone = (r: DeniedAddressRow): DeniedAddressRow => ({ ...r });

function makeFake() {
  const rows: DeniedAddressRow[] = [];
  const auditEntries: Array<Record<string, unknown>> = [];
  let seq = 0;

  const scopedFor = (accountId: string) => ({
    deniedAddress: {
      findMany: async () =>
        rows
          .filter((r) => r.account_id === accountId)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
          .map(clone),
      findFirst: async ({ where }: { where: { id?: string; address?: string } }) => {
        const hit = rows.find(
          (r) =>
            r.account_id === accountId &&
            (where.id === undefined || r.id === where.id) &&
            (where.address === undefined || r.address === where.address),
        );
        return hit ? clone(hit) : null;
      },
      create: ({ data }: { data: Record<string, unknown> }) =>
        statement(() => {
          const row = {
            account_id: accountId,
            note: null,
            created_at: new Date(1_700_000_000_000 + ++seq),
            ...data,
          } as unknown as DeniedAddressRow;
          // The unique index, in the fake. A repeat MUST reach P2002 rather than a second row.
          if (rows.some((r) => r.account_id === row.account_id && r.address === row.address)) {
            throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          }
          rows.push(row);
          return clone(row);
        }),
      deleteMany: ({ where }: { where: { id?: string } }) =>
        statement(() => {
          let count = 0;
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.account_id !== accountId) continue;
            if (where.id !== undefined && r.id !== where.id) continue;
            rows.splice(i, 1);
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
    /**
     * ⚠️ Sequential WITH A ROLLBACK, not `Promise.all`. A batch that runs every statement regardless
     * would let the audit entry survive a create that threw — and then "a repeat writes no second
     * entry" would pass in the test and be false in Postgres, which is the shape of failure this
     * whole file exists to catch.
     */
    $transaction: async (list: unknown[]) => {
      const rowsBefore = rows.map(clone);
      const auditBefore = auditEntries.length;
      try {
        const out: unknown[] = [];
        for (const s of list) out.push(await (s as Promise<unknown>));
        return out;
      } catch (err) {
        rows.splice(0, rows.length, ...rowsBefore);
        auditEntries.length = auditBefore;
        throw err;
      }
    },
  });

  const prisma = {
    forAccount: (accountId: string) => {
      if (!accountId) throw new Error('account context is required (fail-closed)');
      return scopedFor(accountId);
    },
    // The account-free half — the edge read, and the ONLY method that has one (see the repository).
    deniedAddress: {
      findMany: async () =>
        [...rows].sort((a, b) => a.address.localeCompare(b.address)).map((r) => ({ address: r.address })),
    },
  };

  return { prisma: prisma as unknown as PrismaService, rows, auditEntries };
}

function build() {
  const fake = makeFake();
  const service = new DeniedAddressService(
    new DeniedAddressRepository(fake.prisma),
    new AuditRepository(fake.prisma),
  );
  return {
    ...fake,
    service,
    controller: new DeniedAddressGrpcController(service),
    edge: new DeniedAddressEdgeController(service),
  };
}

const ADMIN_PERMS = ['users.list.view', 'platform.settings.manage'];

function md(accountId = 'acct-A', permissions = ADMIN_PERMS): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', permissions.join(','));
  return m;
}

const systemMd = (): Metadata => {
  const m = new Metadata();
  m.set('x-actor-kind', 'system');
  return m;
};

const actor = (accountId = 'acct-A') => ({ accountId, userId: 'u-admin' });


void actor;

describe('an administrator bans an address (FR-024)', () => {
  it('⭐ the address is stored, listed and audited — once', async () => {
    const { controller, rows, auditEntries } = build();

    const added = await controller.addDeniedAddress(
      { address: '203.0.113.7', note: 'scraper' },
      md(),
    );
    expect(added.created).toBe(true);
    expect(added.address).toMatchObject({ address: '203.0.113.7', note: 'scraper' });
    expect(added.address.createdBy).toBe('u-admin');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ account_id: 'acct-A', address: '203.0.113.7', note: 'scraper' });

    const listed = await controller.listDeniedAddresses({}, md());
    expect(listed.addresses.map((a) => a.address)).toEqual(['203.0.113.7']);
    expect(Object.keys(listed.addresses[0]!).sort()).toEqual(
      ['address', 'createdAt', 'createdBy', 'id', 'note'].sort(),
    );

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]!.action).toBe('ip_ban.config_changed');
  });

  it('an address with no note is stored as NULL, and answers `` on the wire', async () => {
    const { controller, rows } = build();
    const added = await controller.addDeniedAddress({ address: '198.51.100.4' }, md());
    expect(rows[0]!.note).toBeNull();
    expect(added.address.note).toBe('');
  });
});

describe('a repeat is a quiet success, not a conflict (contract §A1)', () => {
  it('⭐ the same address twice ⇒ ONE row, ONE journal entry, and the existing row as the answer', async () => {
    const { controller, rows, auditEntries } = build();

    const first = await controller.addDeniedAddress({ address: '203.0.113.7' }, md());
    const again = await controller.addDeniedAddress({ address: '203.0.113.7', note: 'again' }, md());

    // Not an error, and not a second row: the administrator expressed the same intent twice.
    expect(again.created).toBe(false);
    expect(again.address.id).toBe(first.address.id);
    expect(rows).toHaveLength(1);
    // ⚠️ The collision rolls the transaction back, so the list did not change and the trail has
    // nothing to record. A second entry here would report a ban that was already in force.
    expect(auditEntries).toHaveLength(1);
  });

  it('the repeat does not overwrite the note the first one carried', async () => {
    const { controller, rows } = build();
    await controller.addDeniedAddress({ address: '203.0.113.7', note: 'scraper' }, md());
    await controller.addDeniedAddress({ address: '203.0.113.7', note: 'something else' }, md());
    expect(rows[0]!.note).toBe('scraper');
  });
});

describe('removal is idempotent (FR-024)', () => {
  it('⭐ the first removal takes the row; the second answers `false` rather than failing', async () => {
    const { controller, rows, auditEntries } = build();
    const added = await controller.addDeniedAddress({ address: '203.0.113.7' }, md());

    expect(await controller.removeDeniedAddress({ id: added.address.id }, md())).toEqual({
      removed: true,
    });
    expect(rows).toEqual([]);

    expect(await controller.removeDeniedAddress({ id: added.address.id }, md())).toEqual({
      removed: false,
    });
    // Two entries would be one act too many: the second call changed nothing.
    expect(auditEntries.filter((e) => e.action === 'ip_ban.config_changed')).toHaveLength(2);
    expect(auditEntries[1]!.target_ref).toBe('203.0.113.7');
  });

  it('an id that never existed is `removed: false`, with nothing written', async () => {
    const { controller, auditEntries } = build();
    expect(await controller.removeDeniedAddress({ id: 'never-existed' }, md())).toEqual({
      removed: false,
    });
    expect(auditEntries).toEqual([]);
  });
});

describe('the stored form is the NORMALISED one (FR-029)', () => {
  it.each([
    ['  203.0.113.7  ', '203.0.113.7', 'surrounding space'],
    ['::FFFF:203.0.113.7', '203.0.113.7', 'the IPv4-mapped IPv6 form a v6 socket presents'],
    ['2001:DB8::1', '2001:db8::1', 'upper case'],
  ])('%s is stored as %s (%s)', async (typed, stored) => {
    const { controller, rows } = build();
    const added = await controller.addDeniedAddress({ address: typed }, md());
    expect(rows[0]!.address).toBe(stored);
    // The screen must show what actually compares, not what somebody typed.
    expect(added.address.address).toBe(stored);
  });

  it('⭐ one machine written two ways is banned ONCE — the second form collides with the first', async () => {
    const { controller, rows } = build();
    await controller.addDeniedAddress({ address: '203.0.113.7' }, md());
    const again = await controller.addDeniedAddress({ address: '::ffff:203.0.113.7' }, md());
    expect(again.created).toBe(false);
    expect(rows).toHaveLength(1);
  });
});

describe('the wire refuses what the boundary could never match', () => {
  it.each([
    ['', 'blank'],
    ['   ', 'whitespace'],
    ['not-an-address', 'prose'],
    ['10.0.0.0/24', '⛔ a CIDR range — deliberately out of scope, not silently stored'],
    ['192.168.1.*', 'a wildcard'],
    ['010.0.0.1', '⭐ a leading zero — `Number()` accepts it and no real client ever presents it'],
    ['256.0.0.1', 'an octet out of range'],
    ['203.0.113', 'three octets'],
    ['fe80::1%eth0', 'a zone suffix — an interface on one machine, not an address'],
    ['2001:db8:::1', 'a malformed IPv6'],
  ])('%s is INVALID_ARGUMENT (%s)', async (address) => {
    const { controller, rows, auditEntries } = build();
    await expect(controller.addDeniedAddress({ address }, md())).rejects.toThrow(RpcException);
    expect(rows).toEqual([]);
    expect(auditEntries).toEqual([]);
  });

  it('a note longer than a label is refused rather than truncated', async () => {
    const { controller, rows } = build();
    await expect(
      controller.addDeniedAddress({ address: '203.0.113.7', note: 'x'.repeat(121) }, md()),
    ).rejects.toThrow(RpcException);
    expect(rows).toEqual([]);
  });

  it('the shapes a real client DOES present are all accepted', async () => {
    const { controller, rows } = build();
    for (const address of ['10.0.0.1', '203.0.113.7', '::1', '2001:db8::1', '1:2:3:4:5:6:7:8']) {
      await controller.addDeniedAddress({ address }, md());
    }
    expect(rows).toHaveLength(5);
  });
});

describe('⭐ the journal: the address is the TARGET and the detail is EMPTY (FR-032, research D5)', () => {
  const IP_BAN = 'ip_ban.config_changed';

  it('the entry names the address in `target_ref` and carries no detail at all', async () => {
    const { controller, auditEntries } = build();
    await controller.addDeniedAddress({ address: '203.0.113.7', note: 'scraper' }, md());

    const entry = auditEntries[0]!;
    expect(entry.action).toBe(IP_BAN);
    expect(entry.actor_user_id).toBe('u-admin');
    expect(entry.target_ref).toBe('203.0.113.7');
    expect(entry.detail_json ?? null).toBeNull();
    // The note is the administrator's own words and stays on the row, not in the trail.
    expect(JSON.stringify(entry)).not.toContain('scraper');
  });

  /**
   * ⭐ **The counterfactual, which is the whole point of the placement.**
   *
   * `looksLikePersonalData` strips dots before counting digits: `203.0.113.7` becomes an 8-digit run
   * and is refused, `10.0.0.1` becomes 5 digits and passes. So an address in `detail_json` would make
   * recording a ban succeed or fail DEPENDING ON WHICH ADDRESS WAS BANNED — the W31 fingerprint
   * defect, where ~1 issuance in 220 would have thrown under a fully green suite.
   *
   * The key is taken from the action's OWN class allow-list, so this stays true if the catalogue ever
   * re-files the action: what is being proven is the value check, not the key check.
   */
  it('putting the address in the DETAIL fails — and fails at random, which is why it must not be there', () => {
    const allowedKey = DETAIL_KEYS[classOf(IP_BAN)][0]!;

    expect(() => parseDetail(IP_BAN, { [allowedKey]: '203.0.113.7' })).toThrow(/personal data/);
    // …and the same code path accepts a different address. One line apart: that is the randomness.
    expect(() => parseDetail(IP_BAN, { [allowedKey]: '10.0.0.1' })).not.toThrow();

    // Under any other key it is refused by the allow-list instead — there is no way to put it there.
    expect(() =>
      buildEntry({
        action: IP_BAN,
        actorUserId: 'u-admin',
        targetRef: '203.0.113.7',
        detail: { address: '203.0.113.7' },
      }),
    ).toThrow();
  });

  it('`target_ref` accepts every address — which is why the target is where it belongs', () => {
    for (const address of ['203.0.113.7', '10.0.0.1', '2001:db8::1', '1:2:3:4:5:6:7:8']) {
      expect(
        buildEntry({ action: IP_BAN, actorUserId: 'u-admin', targetRef: address }).target_ref,
      ).toBe(address);
    }
  });
});

describe('a denied address belongs to ONE account on every admin path (Principle I)', () => {
  it("⭐ account B cannot see or remove account A's entry — even holding its id", async () => {
    const { controller, rows } = build();
    const added = await controller.addDeniedAddress({ address: '203.0.113.7' }, md('acct-A'));

    expect((await controller.listDeniedAddresses({}, md('acct-B'))).addresses).toEqual([]);
    expect(await controller.removeDeniedAddress({ id: added.address.id }, md('acct-B'))).toEqual({
      removed: false,
    });
    // Nothing moved: the row is still there and still account A's.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account_id).toBe('acct-A');
  });

  it('the same address on two accounts is two rows — uniqueness is per account, not global', async () => {
    const { controller, rows } = build();
    const a = await controller.addDeniedAddress({ address: '203.0.113.7' }, md('acct-A'));
    const b = await controller.addDeniedAddress({ address: '203.0.113.7' }, md('acct-B'));
    expect(b.created).toBe(true);
    expect(b.address.id).not.toBe(a.address.id);
    expect(rows.map((r) => r.account_id).sort()).toEqual(['acct-A', 'acct-B']);
  });

  it('fails closed with no account context at all', async () => {
    const { controller } = build();
    const bare = new Metadata();
    bare.set('x-actor-permissions', ADMIN_PERMS.join(','));
    await expect(controller.listDeniedAddresses({}, bare)).rejects.toThrow(RpcException);
    await expect(controller.addDeniedAddress({ address: '203.0.113.7' }, bare)).rejects.toThrow(
      RpcException,
    );
  });
});

describe('the edge reads the DEPLOYMENT-WIDE union (research D4)', () => {
  it('⭐ the union spans accounts and is deduplicated — an anonymous request has no account to scope by', async () => {
    const { controller, edge, service } = build();
    await controller.addDeniedAddress({ address: '203.0.113.7' }, md('acct-A'));
    await controller.addDeniedAddress({ address: '203.0.113.7' }, md('acct-B'));
    await controller.addDeniedAddress({ address: '198.51.100.4' }, md('acct-B'));

    expect((await edge.listDeniedAddressesForEdge({}, systemMd())).addresses).toEqual([
      '198.51.100.4',
      '203.0.113.7',
    ]);
    // ⚠️ Addresses ONLY: no id, no note, no author, no account — a caller learns that a string is
    // banned somewhere and nothing about whose list it sits on.
    expect(await service.listForEdge()).toEqual(['198.51.100.4', '203.0.113.7']);
  });

  it('an empty deployment answers an empty list — which denies nobody (FR-027)', async () => {
    const { edge } = build();
    expect((await edge.listDeniedAddressesForEdge({}, systemMd())).addresses).toEqual([]);
  });

  it('removing the last row takes the address out of the union', async () => {
    const { controller, edge } = build();
    const added = await controller.addDeniedAddress({ address: '203.0.113.7' }, md());
    await controller.removeDeniedAddress({ id: added.address.id }, md());
    expect((await edge.listDeniedAddressesForEdge({}, systemMd())).addresses).toEqual([]);
  });
});

describe('the service never acquired a logger, structurally', () => {
  it('⛔ no file in this module imports or constructs one — addresses pass through it', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const here = __dirname;
    const files = (await readdir(here)).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
    // Anti-vacuous: the scan must actually find this module's three files.
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = await readFile(`${here}/${file}`, 'utf8');
      expect(source).not.toMatch(/\bnew Logger\b|\bLogger\s*[,}]|console\.(log|info|warn|error)/);
    }
  });
});
