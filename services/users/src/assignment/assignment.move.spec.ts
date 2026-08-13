import { AssignmentService } from './assignment.service';
import { AssignmentRepository } from './assignment.repository';
import type { PrismaService } from '../prisma.service';
import type { PlayerRepository } from '../player/player.repository';
import type { OperatorRepository } from '../operator/operator.repository';
import { maskPlayer } from '../player/player.masking';

/**
 * T032–T034 (feature 026, roadmap 5.7 — US3): **a player moves, and the past survives.**
 *
 * Run against the REAL repository over a fake Prisma, rather than a fake repository — because the
 * property under test is about what the STORE does (a closed row stays; the active lookup ignores
 * it), and a fake repository would be asserting its own implementation.
 *
 * ⚠️ Why FR-003 matters beyond tidiness: Q3.2 (*are an AM's notes about the player, or about that
 * manager's work?*) is unanswered. Additive history is what keeps that question answerable **later at
 * no migration cost** — whichever way the operator decides, the record of who held the player when
 * is still there.
 */

const PLAYER = { brandId: 'brand-a', playerId: 'ply-1' };

function makeStore() {
  interface Row {
    id: string;
    account_id: string;
    brand_id: string;
    player_id: string;
    am_auth_user_id: string;
    assigned_by: string;
    started_at: Date;
    ended_at: Date | null;
    ended_by: string | null;
  }
  const rows: Row[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;

  const matches = (r: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR' && Array.isArray(v))
        return v.some((o) => matches(r, o as Record<string, unknown>));
      return (r as unknown as Record<string, unknown>)[k] === v;
    });

  const delegate = {
    async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
      const f = rows.find((r) => matches(r, where));
      return f ? { ...f } : null;
    },
    async findMany({ where }: { where?: Record<string, unknown> } = {}) {
      return rows.filter((r) => matches(r, where)).map((r) => ({ ...r }));
    },
    async create({ data }: { data: Record<string, unknown> }) {
      seq += 1;
      const row = {
        id: `as-${seq}`,
        started_at: new Date(2026, 7, 2, 10, seq),
        ended_at: null,
        ended_by: null,
        ...data,
      } as Row;
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = rows.find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    },
  };

  const db = {
    playerAssignment: delegate,
    auditEntry: {
      create: async (a: Record<string, unknown>) => {
        audits.push(a);
      },
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db);
    },
  };

  const prisma = { forAccount: () => db } as unknown as PrismaService;
  const repo = new AssignmentRepository(prisma);
  const players = {
    async getPlayer() {
      return { player_id: 'ply-1' };
    },
  } as unknown as PlayerRepository;
  const operators = {
    async resolveByAuthUserIds(_a: string, ids: readonly string[]) {
      return ids.map((i) => ({ operatorId: `op-${i}`, authUserId: i }));
    },
  } as unknown as OperatorRepository;

  return { service: new AssignmentService(repo, players, operators), repo, rows, audits };
}

describe('⭐ a move preserves the past (US3 / FR-003)', () => {
  it('after a move B is active and A is not', async () => {
    const { service, repo } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    await service.unassign('acc-1', PLAYER, 'lead-1');
    await service.assign('acc-1', PLAYER, 'am-B', 'lead-1');

    expect((await repo.activeFor('acc-1', PLAYER))?.am_auth_user_id).toBe('am-B');
    expect(await repo.isAttached('acc-1', PLAYER, 'am-A')).toBe(false);
    expect(await repo.isAttached('acc-1', PLAYER, 'am-B')).toBe(true);
  });

  it("⭐ A's period is STILL THERE — a move adds to history, never overwrites", async () => {
    const { service, repo, rows } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    await service.unassign('acc-1', PLAYER, 'lead-1');
    await service.assign('acc-1', PLAYER, 'am-B', 'lead-1');

    // Two rows, not one edited row. This is what keeps Q3.2 answerable at no migration cost.
    expect(rows).toHaveLength(2);
    const history = await repo.historyFor('acc-1', PLAYER);
    expect(history.map((h) => h.am_auth_user_id).sort()).toEqual(['am-A', 'am-B']);
    const closed = history.find((h) => h.ended_at !== null)!;
    expect(closed.am_auth_user_id).toBe('am-A');
    expect(closed.ended_by).toBe('lead-1');
  });

  it('the trail holds one detach and one attach, each naming the caller', async () => {
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    await service.unassign('acc-1', PLAYER, 'lead-2');
    await service.assign('acc-1', PLAYER, 'am-B', 'lead-2');

    expect(audits.map((a) => (a.data as Record<string, unknown>).action)).toEqual([
      'player.assign',
      'player.unassign',
      'player.assign',
    ]);
    expect((audits[1]!.data as Record<string, unknown>).actor_user_id).toBe('lead-2');
  });

  it('⚠️ the second attach is REFUSED if the first was not closed first', async () => {
    // There is no `TransferPlayer` verb, deliberately: a move is two audited acts, and Q3.1 (who may
    // take a player away) is still open — a combined verb would bake in an answer nobody has given.
    const { service } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    expect((await service.assign('acc-1', PLAYER, 'am-B', 'lead-1')).status).toBe(
      'already_assigned',
    );
  });
});

describe('⭐ access follows the CURRENT attachment, never a past one (T034)', () => {
  const RECORD = {
    player_id: 'ply-1',
    vip: true,
    am_notes: 'note',
    preferences: 'p',
    portfolio: 'f',
  };

  it('A loses the AM tier the moment the player moves, with no overlap', async () => {
    const { service, repo } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');

    // While attached: A sees the portfolio.
    const before = maskPlayer(RECORD, 'am', {
      attachedToSubject: await repo.isAttached('acc-1', PLAYER, 'am-A'),
    }) as Record<string, unknown>;
    expect(before.am_notes).toBe('note');

    await service.unassign('acc-1', PLAYER, 'lead-1');
    await service.assign('acc-1', PLAYER, 'am-B', 'lead-1');

    // ⭐ Immediately after: A sees nothing, B sees everything. No interval in which both can read it —
    // the answer comes from the active row, and there is only ever one.
    const afterA = maskPlayer(RECORD, 'am', {
      attachedToSubject: await repo.isAttached('acc-1', PLAYER, 'am-A'),
    }) as Record<string, unknown>;
    const afterB = maskPlayer(RECORD, 'am', {
      attachedToSubject: await repo.isAttached('acc-1', PLAYER, 'am-B'),
    }) as Record<string, unknown>;

    expect('am_notes' in afterA).toBe(false);
    expect(afterB.am_notes).toBe('note');
  });

  it('detaching with no re-attach leaves NOBODY able to read the tier', async () => {
    const { service, repo } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    await service.unassign('acc-1', PLAYER, 'lead-1');

    expect(await repo.isAttached('acc-1', PLAYER, 'am-A')).toBe(false);
    expect(await repo.activeFor('acc-1', PLAYER)).toBeNull();
  });

  it('⭐ the AM NOTES themselves are untouched by any of it', async () => {
    // The interim rule for Q3.2: notes and history follow the PLAYER and are never dropped by a
    // re-assignment. Nothing in this feature writes to them, and that is the assertion.
    const { service, audits } = makeStore();
    await service.assign('acc-1', PLAYER, 'am-A', 'lead-1');
    await service.unassign('acc-1', PLAYER, 'lead-1');
    for (const a of audits) {
      expect(JSON.stringify(a)).not.toContain('am_notes');
    }
  });
});
