import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '../prisma.service';
import type { TransitionRecorder } from '../transition/transition.recorder';
import { ConversationRepository } from './conversation.repository';
import { cleanSearch } from './conversation.grpc.controller';

/**
 * ⭐ W24 (R43) — the ticket NUMBER becomes real, and the search over `[номер] тема`.
 *
 * `Conversation.reference` was a reserved column: projected on the wire, rendered in the header,
 * written by NOTHING. These specs pin the writer this block adds:
 *  · the number comes from the per-account counter, INSIDE the same transaction as the insert;
 *  · numbering is sequential per account and independent across accounts (Principle I — a shared
 *    sequence would leak one tenant's volume to another through the gaps);
 *  · the search filter matches the number exactly OR the subject as a substring, and lands in the
 *    `AND` accumulator — never `where.OR`, which `membersIn` already owns.
 *
 * ⚠️ What jsdom-style fakes CANNOT prove here, said plainly: the atomicity of the upsert-increment
 * is Postgres's (`INSERT … ON CONFLICT DO UPDATE`), and the live round creates a real ticket and
 * reads its number back. The fake pins the SHAPE of the calls, not the database's promise.
 */

interface UpsertArgs {
  where: { account_id: string };
  create: { account_id: string; last: number };
  update: { last: { increment: number } };
}

function fakeTxPrisma() {
  const counters = new Map<string, number>();
  const upsert = jest.fn(async (args: UpsertArgs) => {
    const cur = counters.get(args.where.account_id);
    const next = cur === undefined ? args.create.last : cur + args.update.last.increment;
    counters.set(args.where.account_id, next);
    return { last: next };
  });
  const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    ...args.data,
    created_at: new Date(),
    updated_at: new Date(),
  }));
  const tx = {
    conversationReferenceCounter: { upsert },
    conversation: { create, findFirst: jest.fn(), updateMany: jest.fn() },
    conversationTransition: { create: jest.fn() },
  };
  const $transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
  const forAccount = jest.fn().mockReturnValue({ $transaction });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    upsert,
    create,
    $transaction,
  };
}

const recorder = {} as TransitionRecorder;

const input = { brandId: 'brand-a' };

describe('⭐ W24 — the ticket number is assigned at creation, per account, in one transaction', () => {
  it('the first ticket of an account is [1], and the insert carries the number', async () => {
    const f = fakeTxPrisma();
    const repo = new ConversationRepository(f.prisma, recorder);

    const row = (await repo.create('acc-1', input)) as unknown as { reference: string };

    expect(f.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { account_id: 'acc-1' }, create: { account_id: 'acc-1', last: 1 } }),
    );
    expect(f.create.mock.calls[0]![0].data).toMatchObject({ reference: '1' });
    expect(row.reference).toBe('1');
  });

  it('numbering is SEQUENTIAL within an account and INDEPENDENT across accounts', async () => {
    const f = fakeTxPrisma();
    const repo = new ConversationRepository(f.prisma, recorder);

    await repo.create('acc-1', input);
    await repo.create('acc-1', input);
    const references = f.create.mock.calls.map((c) => c[0].data.reference);
    expect(references).toEqual(['1', '2']);

    // A second account starts at 1 — the counter is keyed by account, so tenant B's numbers say
    // nothing about tenant A's ticket volume.
    await repo.create('acc-2', input);
    expect(f.create.mock.calls[2]![0].data).toMatchObject({ reference: '1' });
  });

  it('the counter and the insert share ONE transaction — a failed create burns no number', async () => {
    const f = fakeTxPrisma();
    const repo = new ConversationRepository(f.prisma, recorder);
    await repo.create('acc-1', input);
    // Both calls happened inside the single $transaction callback (the fake's tx is the only object
    // carrying these delegates, and $transaction ran exactly once).
    expect(f.$transaction).toHaveBeenCalledTimes(1);
    expect(f.upsert).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});

describe('⭐ W24 — the schema makes the claims structural (scan, not convention)', () => {
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

  it('two tickets of one account can never share a number — a constraint, not a habit', () => {
    expect(schema).toMatch(/@@unique\(\[account_id, reference\]\)/);
  });

  it('the counter model exists with the shape the transaction relies on', () => {
    expect(schema).toMatch(/model ConversationReferenceCounter \{[^}]*account_id String @id[^}]*last\s+Int/s);
  });
});

describe('W24 — the search filter reaches the query in the accumulator, never where.OR', () => {
  function fakeListPrisma() {
    const findMany = jest.fn().mockResolvedValue([]);
    const forAccount = jest.fn().mockReturnValue({ conversation: { findMany } });
    return { prisma: { forAccount } as unknown as PrismaService, findMany };
  }

  it('matches the number EXACTLY or the subject as a case-insensitive substring', async () => {
    const f = fakeListPrisma();
    const repo = new ConversationRepository(f.prisma, recorder);
    await repo.list('acc-1', { search: '1043', limit: 50, cursor: null });

    const where = f.findMany.mock.calls[0]![0].where as { AND?: unknown[]; OR?: unknown };
    expect(where.AND).toEqual(
      expect.arrayContaining([
        {
          OR: [
            { reference: '1043' },
            { subject: { contains: '1043', mode: 'insensitive' } },
          ],
        },
      ]),
    );
    // membersIn owns the top-level OR; search must not have claimed it (the silent-drop hazard).
    expect(where.OR).toBeUndefined();
  });

  it('no search ⇒ no predicate at all — "" never becomes an empty ILIKE', async () => {
    const f = fakeListPrisma();
    const repo = new ConversationRepository(f.prisma, recorder);
    await repo.list('acc-1', { limit: 50, cursor: null });
    const where = f.findMany.mock.calls[0]![0].where as { AND?: unknown[] };
    for (const clause of where.AND ?? []) {
      expect(JSON.stringify(clause)).not.toContain('reference');
    }
  });
});

describe('W24 — cleanSearch: what a person pastes off the screen means the number', () => {
  it.each([
    ['[1043]', '1043'],
    ['#1043', '1043'],
    ['1043]', '1043'],
    ['  депозит  ', 'депозит'],
    ['[  1043 ]', '1043'],
  ])('%s → %s', (raw, want) => {
    expect(cleanSearch(raw)).toBe(want);
  });

  it('empty, whitespace and bracket-only inputs mean NO filter — never an empty-string ILIKE', () => {
    expect(cleanSearch(undefined)).toBeUndefined();
    expect(cleanSearch('')).toBeUndefined();
    expect(cleanSearch('   ')).toBeUndefined();
    expect(cleanSearch('[[')).toBeUndefined();
  });

  it('the operand is CAPPED at 100 — an unbounded ILIKE against the largest table is self-harm', () => {
    expect(cleanSearch('x'.repeat(500))!.length).toBe(100);
  });
});
