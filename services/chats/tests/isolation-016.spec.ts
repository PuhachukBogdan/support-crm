import type { PrismaService } from '../src/prisma.service';
import { MessageRepository } from '../src/message/message.repository';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { TransitionRecorder } from '../src/transition/transition.recorder';
import { userActor } from '../src/transition/conversation-transitions';

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
  /** Feature 022 — the contact-stamp writes, kept apart from `writes` (see `updateMany` below). */
  const stamps: Array<{ account: string; data: Record<string, unknown> }> = [];
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
        // Feature 022 turned the write into an INTERACTIVE transaction (the contact stamp needs the
        // created row's own `created_at`, which the batch form cannot reference). So these now resolve
        // like real delegates instead of returning a lazy `__run` statement.
        create: (args: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 'm-new',
            ...args.data,
            created_at: new Date('2026-07-29T12:00:00.000Z'),
            attachments: [],
          }),
      },
      // Feature 023 (T019): the first public reply is recorded as a transition inside this same
      // transaction, so the fake needs the table and a before-row read.
      conversationTransition: { create: jest.fn().mockResolvedValue({}) },
      messageAttachment: {
        createMany: (args: { data: Record<string, unknown>[] }) => {
          writes.push({ account: acc, rows: args.data });
          return Promise.resolve({ count: args.data.length });
        },
      },
      conversation: {
        // Feature 023: the title is returned ALREADY FROZEN, so the derivation window cannot fire and
        // add a second `updateMany` to `stamps`. This file is about account isolation on the
        // attachment path; the window has its own spec with a fake that behaves like a database.
        findFirst: jest.fn().mockResolvedValue({ brand_id: 'brand-a', subject_source: 'auto' }),
        // Feature 022's contact stamp. Recorded SEPARATELY from `writes` on purpose: the assertions
        // below count attachment writes exactly, and folding a second kind of write into that array
        // would loosen an existing guarantee to make room for a new one.
        updateMany: (args: { data: Record<string, unknown> }) => {
          stamps.push({ account: acc, data: args.data });
          return Promise.resolve({ count: 1 });
        },
      },
    } as Record<string, unknown>;
    (scoped as { $transaction: unknown }).$transaction = (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.resolve(arg.map((s) => (s as { __run: () => unknown }).__run()))
        : (arg as (tx: unknown) => Promise<unknown>)(scoped);
    return scoped;
  });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount, writes, stamps };
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
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder()).thread(OURS, 'c1', 'staff', 50, null);
    expect(rows.map((r) => r.id)).toEqual(['m-ours']);
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain('up-theirs-secret');
    expect(payload).not.toContain('m-theirs');
  });

  it('the other account sees only its own', async () => {
    const { prisma } = fakePrisma();
    const { rows } = await new MessageRepository(prisma, new TransitionRecorder()).thread(THEIRS, 'c1', 'staff', 50, null);
    expect(rows.map((r) => r.id)).toEqual(['m-theirs']);
  });

  it('the read never scopes to another account', async () => {
    const { prisma, forAccount } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder()).thread(OURS, 'c1', 'staff', 50, null);
    expect(forAccount).toHaveBeenCalledWith(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
  });
});

describe('*** an attachment row is stamped with the CALLER’s account ***', () => {
  it('never with one taken from the request', async () => {
    const { prisma, writes } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder()).post(OURS, {
      conversationId: 'c1',
      authorType: 'operator',
      authorId: 'op-1',
      body: 'with a file',
      isPrivate: false,
      mentions: [],
      uploadIds: ['up-ours'],
    }, userActor('u1'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.account).toBe(OURS);
    expect(writes[0]!.rows.every((r) => r.account_id === OURS)).toBe(true);
  });
});

/**
 * Feature 022 (roadmap 4.13) — the contact stamp is a THIRD write on this path, and it is a write to a
 * row the request names (`conversationId`). So it is exactly the shape this file exists to police: the
 * caller supplies an id, and the account must come from the actor and never from the request.
 */
describe('*** the contact stamp goes through the CALLER’s scoped client ***', () => {
  it('stamps the conversation for the acting account only', async () => {
    const { prisma, stamps, forAccount } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder()).post(OURS, {
      conversationId: 'c1',
      authorType: 'operator',
      authorId: 'op-1',
      body: 'a public reply',
      isPrivate: false,
      mentions: [],
    }, userActor('u1'));
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.account).toBe(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
    // The stamped column carries a timestamp, not a boolean flag or a marker — the value is the created
    // message's own `created_at` (research R2).
    expect(stamps[0]!.data.last_outbound_at).toBeInstanceOf(Date);
  });

  it('writes NO stamp for a private note, so a note cannot touch another account’s row either', async () => {
    const { prisma, stamps } = fakePrisma();
    await new MessageRepository(prisma, new TransitionRecorder()).post(OURS, {
      conversationId: 'c1',
      authorType: 'operator',
      authorId: 'op-1',
      body: 'internal',
      isPrivate: true,
      mentions: [],
    }, userActor('u1'));
    expect(stamps).toEqual([]);
  });
});
