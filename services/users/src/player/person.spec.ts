import { PersonService } from './person.service';
import { playerIdentity } from './player.identity';
import type { PrismaService } from '../prisma.service';
import type { AuditRepository } from '../audit/audit.repository';

/**
 * T021/T023/T024 (feature 020, US2) — automatic linking, and the three things it refuses.
 *
 * The operator chose automatic. These tests hold what makes that safe: it never fires on a shared
 * platform id, never crosses accounts, never fires on a value that clearly is not a person, and can
 * always be undone without anything having moved.
 */

type Holder = { account_id: string; brand_id: string; player_id: string };
type Member = Holder & { person_id: string };

function fakeDb(holders: Holder[], members: Member[] = []) {
  const created: Array<{ account_id: string }> = [];
  const upserted: Array<Record<string, unknown>> = [];
  const deleted: Array<Record<string, unknown>> = [];

  const client = {
    contactMatch: { findMany: jest.fn(async () => holders) },
    personMember: {
      findMany: jest.fn(async () => members),
      upsert: jest.fn(async (args: Record<string, unknown>) => {
        upserted.push(args);
        return {};
      }),
      deleteMany: jest.fn(async (args: Record<string, unknown>) => {
        deleted.push(args);
        return { count: members.length ? 1 : 0 };
      }),
    },
    person: {
      create: jest.fn(async (args: { data: { account_id: string } }) => {
        created.push(args.data);
        return { id: 'person-new' };
      }),
    },
  };
  const forAccount = jest.fn(() => client);

  // The trail is part of the act, not an observer of it — a link with no record of itself is only
  // discoverable later, as a card that quietly contains someone else.
  const appended: Array<Record<string, unknown>> = [];
  const auditRepo = {
    append: jest.fn(async (accountId: string, entry: Record<string, unknown>) => {
      appended.push({ accountId, ...entry });
    }),
  } as unknown as AuditRepository;

  return {
    prisma: { forAccount } as unknown as PrismaService,
    client,
    forAccount,
    created,
    upserted,
    deleted,
    auditRepo,
    appended,
  };
}

const A = playerIdentity({ accountId: 'acc-1', brandId: 'brand-a', playerId: '12345' });
const holderA = { account_id: 'acc-1', brand_id: 'brand-a', player_id: '12345' };
const holderB = { account_id: 'acc-1', brand_id: 'brand-b', player_id: '99999' };
const HASH = 'a'.repeat(64);

describe('T021 — two records sharing a contact hash are linked with NO human action', () => {
  it('creates one person and enrols both records', async () => {
    const f = fakeDb([holderA, holderB]);
    const out = await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    expect(out.status).toBe('linked');
    expect(out.personId).toBe('person-new');
    expect(f.upserted).toHaveLength(2);
  });

  it('records WHICH KIND established the link, and never a value', async () => {
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'phone', HASH);

    const created = f.upserted.map((u) => (u as { create: Record<string, unknown> }).create);
    for (const row of created) expect(row.linked_on).toBe('phone');

    // SEC-26: no hash, no address, no number anywhere in what is written.
    const written = JSON.stringify(f.upserted);
    expect(written).not.toContain(HASH);
    expect(written).not.toContain('@');
  });

  it('*** a shared platform id is NOT grounds — nothing here reads one ***', async () => {
    // The collision this whole feature undoes. Two records with the same player_id and no shared
    // contact hash produce no holders, so there is nothing to link.
    const f = fakeDb([holderA]); // one holder = the hash is on a single record
    const out = await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    expect(out.status).toBe('no-match');
    expect(f.client.person.create).not.toHaveBeenCalled();
    expect(f.upserted).toHaveLength(0);
  });

  it('a re-run is a no-op, not a second person', async () => {
    const members = [
      { ...holderA, person_id: 'person-1' },
      { ...holderB, person_id: 'person-1' },
    ];
    const f = fakeDb([holderA, holderB], members);
    const out = await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    expect(out.status).toBe('already-linked');
    expect(f.client.person.create).not.toHaveBeenCalled();
  });

  it('a third record joins the EXISTING person rather than starting another', async () => {
    const f = fakeDb([holderA, holderB], [{ ...holderA, person_id: 'person-1' }]);
    const out = await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    expect(out.personId).toBe('person-1');
    expect(f.client.person.create).not.toHaveBeenCalled();
  });
});

describe('T022 — an identifier on three or more records links NOTHING', () => {
  it('declines, and says why', async () => {
    // The placeholder case: `noemail@brand.com`, a branch phone. Not a rare wrong link — a rule that
    // would fuse strangers in bulk.
    const many = [holderA, holderB, { account_id: 'acc-1', brand_id: 'brand-c', player_id: '7' }];
    const f = fakeDb(many);
    const out = await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    expect(out.status).toBe('too-many-records');
    expect(f.client.person.create).not.toHaveBeenCalled();
    expect(f.upserted).toHaveLength(0);
  });
});

describe('T024 — the trail records both halves, and never a value', () => {
  it('a link writes an entry per record, naming the KIND of identifier', async () => {
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH, 'user-7');

    expect(f.appended).toHaveLength(2);
    for (const e of f.appended) {
      expect(e.action).toBe('player.link');
      expect(e.actorUserId).toBe('user-7');
      expect(e.detail).toEqual({ linkedOn: 'email' });
    }
    // The subject is the brand-scoped record — "player 12345" alone would not say which customer.
    expect(f.appended.map((e) => e.targetRef).sort()).toEqual([
      'brand-a/12345',
      'brand-b/99999',
    ]);
  });

  it('no hash and no contact value reaches the trail (SEC-26)', async () => {
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);
    const written = JSON.stringify(f.appended);
    expect(written).not.toContain(HASH);
    expect(written).not.toContain('@');
  });

  it('an UNLINK is recorded too — otherwise only the mistake is on the record', async () => {
    const f = fakeDb([holderA, holderB], [{ ...holderA, person_id: 'person-1' }]);
    await new PersonService(f.prisma, f.auditRepo).unlink(A, 'user-7');

    expect(f.appended).toEqual([
      expect.objectContaining({ action: 'player.unlink', targetRef: 'brand-a/12345' }),
    ]);
  });

  it('an unlink that removed nothing writes nothing', async () => {
    const f = fakeDb([holderA]);
    await new PersonService(f.prisma, f.auditRepo).unlink(A);
    expect(f.appended).toEqual([]);
  });

  it('a declined link writes nothing at all', async () => {
    const many = [holderA, holderB, { account_id: 'acc-1', brand_id: 'brand-c', player_id: '7' }];
    const f = fakeDb(many);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);
    expect(f.appended).toEqual([]);
  });
});

describe('T023 — linking never crosses accounts', () => {
  it('the search itself is account-bounded, so a foreign match is never even found', async () => {
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    // Structural, not a comparison afterwards: `forAccount` is the boundary (Principle I).
    expect(f.forAccount).toHaveBeenCalledWith('acc-1');
    expect(f.client.contactMatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { value_hash: HASH } }),
    );
  });

  it('the person is created inside the caller account', async () => {
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);
    expect(f.created).toEqual([{ account_id: 'acc-1' }]);
  });
});

describe('T024 — unlink leaves two independent records, with nothing copied', () => {
  it('removes only the membership', async () => {
    const f = fakeDb([holderA, holderB], [{ ...holderA, person_id: 'person-1' }]);
    const out = await new PersonService(f.prisma, f.auditRepo).unlink(A);

    expect(out.unlinked).toBe(true);
    expect(f.deleted).toEqual([
      { where: { account_id: 'acc-1', brand_id: 'brand-a', player_id: '12345' } },
    ]);
  });

  it('*** a link copies NO field, so there is nothing to restore on unlink ***', async () => {
    // The property that makes an automatic decision correctable. If linking merged notes or a VIP
    // flag, an unlink could not put the previous state back and the operator's accepted rare wrong
    // link would be permanent damage instead of a click.
    const f = fakeDb([holderA, holderB]);
    await new PersonService(f.prisma, f.auditRepo).linkByContact(A, 'email', HASH);

    const written = f.upserted.map((u) => (u as { create: Record<string, unknown> }).create);
    for (const row of written) {
      expect(Object.keys(row).sort()).toEqual([
        'account_id',
        'brand_id',
        'linked_on',
        'person_id',
        'player_id',
      ]);
      for (const field of ['vip', 'segment', 'am_notes', 'preferences', 'gr8_snapshot']) {
        expect(row).not.toHaveProperty(field);
      }
    }
  });

  it('unlinking something that was never linked is not an error', async () => {
    const f = fakeDb([holderA]);
    await expect(new PersonService(f.prisma, f.auditRepo).unlink(A)).resolves.toEqual({ unlinked: false });
  });
});

describe('membersOf — the input to the person-scoped feed', () => {
  it('returns full identities, never bare platform ids', async () => {
    const f = fakeDb([], [{ ...holderA, person_id: 'p1' }, { ...holderB, person_id: 'p1' }]);
    const members = await new PersonService(f.prisma, f.auditRepo).membersOf('acc-1', 'p1');

    expect(members).toEqual([
      { accountId: 'acc-1', brandId: 'brand-a', playerId: '12345' },
      { accountId: 'acc-1', brandId: 'brand-b', playerId: '99999' },
    ]);
  });
});
