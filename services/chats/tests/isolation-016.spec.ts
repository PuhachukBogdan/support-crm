import type { PrismaService } from '../src/prisma.service';
import { MessageRepository } from '../src/message/message.repository';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';

/**
 * T058 (feature 016) — cross-account isolation for `MessageAttachment` (Principle I / SC-005).
 *
 * `MessageAttachment` carries an `account_id` of its own even though it always hangs off a Message
 * that has one. That redundancy is the subject of this file: an attachment must be unreachable
 * across the boundary ON ITS OWN TERMS, not merely because its parent happens to be scoped. A future
 * query that reaches attachments by any route other than the message relation would otherwise have
 * no account predicate at all.
 */
const OURS = 'acc-1';
const THEIRS = 'acc-2';

const messages = [
  {
    id: 'm-ours',
    account_id: OURS,
    conversation_id: 'c1',
    author_type: 'operator',
    author_id: 'op-1',
    body: 'ours',
    private: false,
    mentions: [],
    created_at: new Date('2026-07-29T10:00:00.000Z'),
    attachments: [{ upload_id: 'up-ours', position: 0 }],
  },
  {
    id: 'm-theirs',
    account_id: THEIRS,
    // The SAME conversation id in a different account — the trap. A missing account predicate would
    // return this row for a caller in `acc-1`, together with the upload id it references.
    conversation_id: 'c1',
    author_type: 'operator',
    author_id: 'op-9',
    body: 'theirs',
    private: false,
    mentions: [],
    created_at: new Date('2026-07-29T11:00:00.000Z'),
    attachments: [{ upload_id: 'up-theirs-secret', position: 0 }],
  },
];

/** Reproduces the feature-007 extension: every operation is confined to one account. */
function fakePrisma() {
  const writes: Array<{ account: string; rows: Record<string, unknown>[] }> = [];
  const forAccount = jest.fn((acc: string) => {
    const scoped = {
      message: {
        findMany: ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            messages.filter(
              (m) =>
                m.account_id === acc &&
                (!where.conversation_id || m.conversation_id === where.conversation_id),
            ),
          ),
        create: (args: { data: Record<string, unknown> }) => ({
          __run: () => ({ ...args.data, created_at: new Date(), attachments: [] }),
        }),
      },
      messageAttachment: {
        createMany: (args: { data: Record<string, unknown>[] }) => ({
          __run: () => {
            writes.push({ account: acc, rows: args.data });
            return { count: args.data.length };
          },
        }),
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ brand_id: 'brand-a' }) },
    } as Record<string, unknown>;
    (scoped as { $transaction: unknown }).$transaction = (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.resolve(arg.map((s) => (s as { __run: () => unknown }).__run()))
        : Promise.resolve([]);
    return scoped;
  });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount, writes };
}

describe('MessageAttachment is an account-scoped model', () => {
  it('it is registered, so the feature-007 extension enforces account_id on it', () => {
    // The coverage spec (tests/data-model/account-scope-coverage.spec.ts) fails if a table declares
    // `account_id` and is NOT listed here. This asserts the other direction explicitly, because the
    // consequence of an omission is silent: every attachment query would run unscoped.
    expect(SCOPED_MODELS).toContain('MessageAttachment');
  });
});

describe('*** a cross-account thread read returns no attachment ids ***', () => {
  it('the neighbour’s message and its upload id are both invisible', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma).thread(OURS, 'c1', 'staff', 50, null);
    expect(rows.map((r) => r.id)).toEqual(['m-ours']);
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain('up-theirs-secret');
    expect(payload).not.toContain('m-theirs');
  });

  it('the other account sees only its own', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma).thread(THEIRS, 'c1', 'staff', 50, null);
    expect(rows.map((r) => r.id)).toEqual(['m-theirs']);
  });

  it('the read never scopes to another account', async () => {
    const { prisma, forAccount } = fakePrisma();
    await new MessageRepository(prisma).thread(OURS, 'c1', 'staff', 50, null);
    expect(forAccount).toHaveBeenCalledWith(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
  });
});

describe('*** an attachment row is stamped with the CALLER’s account ***', () => {
  it('never with one taken from the request', async () => {
    const { prisma, writes } = fakePrisma();
    await new MessageRepository(prisma).post(OURS, {
      conversationId: 'c1',
      authorType: 'operator',
      authorId: 'op-1',
      body: 'with a file',
      isPrivate: false,
      mentions: [],
      uploadIds: ['up-ours'],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.account).toBe(OURS);
    expect(writes[0]!.rows.every((r) => r.account_id === OURS)).toBe(true);
  });
});
