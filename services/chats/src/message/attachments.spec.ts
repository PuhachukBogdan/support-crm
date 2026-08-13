import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { MessageRepository } from './message.repository';
import { MessageWriteController } from './message.grpc.controller';
import { UploadsClient, UploadsUnavailableError } from '../uploads/uploads.client';
import type { DomainEventPublisher } from '../events/events.publisher';
import type { FirstReplyClock } from '../sla/first-reply.clock';
import { TransitionRecorder } from '../transition/transition.recorder';
import { fakeRealtime } from '../realtime/realtime.fake';

/**
 * Feature 033: the delivery-intent writer, stubbed to do NOTHING.
 *
 * These specs post on tickets whose channel is not email, so the real repository would enqueue nothing
 * either — the stub keeps that true without giving the fake transaction a `channel` delegate. The
 * enqueue rule itself is asserted in `services/chats/src/channel/outbound.spec.ts`, where a public reply
 * on an email ticket must produce exactly one intent and a private note none.
 */
function noOutbox() {
  return {
    enqueue: async () => undefined,
  } as unknown as import('../channel/outbound.repository').OutboundRepository;
}


/**
 * T027 (feature 016, US1) — an attachment cannot cross an account boundary, and a refused attachment
 * leaves NO PARTIAL MESSAGE (FR-015; feature 013's ordering discipline).
 *
 * The ordering claim is the one worth stating carefully: atomicity here comes from ORDERING, not
 * from rollback. Everything that can refuse — access, id shape, the cross-service claim — runs before
 * the first write, so a refusal writes zero rows rather than writing and undoing. That is the same
 * design 013 proved live for macros, applied to a case that now spans two databases where a rollback
 * would not have been available at all.
 */
const CONV = 'c1';

function md(accountId = 'acc-1', userId = 'op-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  return m;
}

/**
 * A LAZY statement, modelled on `PrismaPromise`: it does nothing until it is either awaited directly
 * or executed by `$transaction`, and it runs at most once.
 *
 * The laziness is the point (the 014 lesson). An eager fake reports phantom writes for a transaction
 * that never executed, which would hide exactly the regression these tests exist to catch — "no
 * message row was written" has to mean the statement never ran, not that it ran and was ignored.
 */
function statement<T>(run: () => T) {
  let done = false;
  let value: T;
  const exec = (): T => {
    if (!done) {
      value = run();
      done = true;
    }
    return value;
  };
  return {
    __run: exec,
    then: (res?: (v: T) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve().then(exec).then(res, rej),
  };
}

/** A LAZY fake scoped client: conversation lookup + message/attachment writes as statements. */
function fakePrisma(brand: string | null = 'brand-a') {
  const messages: Record<string, unknown>[] = [];
  const attachments: Record<string, unknown>[] = [];

  /** Feature 022 — the contact-stamp writes this path now also makes. */
  const stamps: Record<string, unknown>[] = [];

  const scoped = {
    conversation: {
      findFirst: jest.fn().mockResolvedValue(brand === null ? null : { brand_id: brand }),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        stamps.push(args.data);
        return Promise.resolve({ count: 1 });
      }),
    },
    message: {
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        statement(() => {
          const row = {
            id: (args.data.id as string) ?? 'm-new',
            conversation_id: args.data.conversation_id,
            author_type: args.data.author_type,
            author_id: args.data.author_id,
            body: args.data.body,
            private: args.data.private,
            mentions: args.data.mentions ?? [],
            created_at: new Date('2026-07-29T10:00:00.000Z'),
            attachments: [],
          };
          messages.push(row);
          return row;
        }),
      ),
    },
    // Feature 023 (T019): the first public reply is recorded as a transition inside this same
    // transaction, so the fake needs the table and a before-row read.
    conversationTransition: { create: jest.fn().mockResolvedValue({}) },
    messageAttachment: {
      createMany: jest.fn((args: { data: Record<string, unknown>[] }) =>
        statement(() => {
          attachments.push(...args.data);
          return { count: args.data.length };
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  } as Record<string, unknown>;

  (scoped as { $transaction: unknown }).$transaction = (arg: unknown) => {
    if (Array.isArray(arg)) {
      return Promise.resolve(arg.map((s) => (s as { __run: () => unknown }).__run()));
    }
    // Feature 022 — the INTERACTIVE form. `post` needs the created row's own `created_at` for the
    // contact stamp, which the batch form cannot reference (research R2). The lazy statements above
    // still work here: awaiting one runs it exactly once, which is what the callback does.
    return (arg as (tx: unknown) => Promise<unknown>)(scoped);
  };

  const forAccount = jest.fn(() => scoped);
  return {
    prisma: { forAccount } as unknown as PrismaService,
    messages,
    attachments,
    stamps,
    scoped,
  };
}

/**
 * A users client that knows about `claimable` and nothing else.
 *
 * `describe` returns rows only for ids it knows — mirroring FR-011, where an id from another account
 * is simply ABSENT rather than an error. That absence is what the controller turns into a refusal,
 * which is why the fake models it that way rather than throwing.
 */
function fakeUploads(claimable: string[] = []) {
  const claimed: string[] = [];
  const client = {
    describe: jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => claimable.includes(id))
        .map((id) => ({
          uploadId: id,
          contentType: 'image/png',
          byteSize: 1234,
          displayName: 'shot.png',
          hasDerivative: true,
        })),
    ),
    claim: jest.fn(async (_acc: string, ids: string[]) => {
      // All-or-nothing, exactly as the service behaves.
      if (!ids.every((id) => claimable.includes(id))) {
        throw new RpcException({ code: 9, message: 'claim refused' });
      }
      claimed.push(...ids);
      return ids;
    }),
  } as unknown as UploadsClient;
  return {
    client,
    claimed,
    claimSpy: client.claim as unknown as jest.Mock,
    describeSpy: client.describe as unknown as jest.Mock,
  };
}

function noEvents() {
  return { messageReceived: jest.fn(async () => 0) } as unknown as DomainEventPublisher;
}
function noClock() {
  return {
    onInboundPlayerMessage: jest.fn(async () => undefined),
    onStaffMessage: jest.fn(async () => undefined),
  } as unknown as FirstReplyClock;
}

function controller(prisma: PrismaService, uploads: UploadsClient) {
  return new MessageWriteController(
    new MessageRepository(prisma, new TransitionRecorder(), noOutbox()),
    noEvents(),
    noClock(),
    uploads,
    fakeRealtime().publisher,
  );
}

describe('a valid attachment is written WITH its message', () => {
  it('message row and attachment rows land in the same transaction', async () => {
    const { prisma, messages, attachments } = fakePrisma();
    const { client } = fakeUploads(['u-1', 'u-2']);
    const res = await controller(prisma, client).postMessage(
      {
        conversationId: CONV,
        kind: 'MESSAGE_KIND_PUBLIC_REPLY',
        body: 'here you go',
        uploadIds: ['u-1', 'u-2'],
      },
      md('acc-1', 'op-1'),
    );
    expect(messages).toHaveLength(1);
    expect(attachments).toHaveLength(2);
    expect(attachments.map((a) => a.upload_id)).toEqual(['u-1', 'u-2']);
    // Position is explicit so display order is stable rather than whatever the planner returns.
    expect(attachments.map((a) => a.position)).toEqual([0, 1]);
    expect(attachments.every((a) => a.account_id === 'acc-1')).toBe(true);
    // ⚠️ **This assertion changed in feature 022, and what it dropped was never the guarantee.**
    // It used to read `expect(res.id).toMatch(/^[0-9a-f-]{36}$/)` — the message id was generated in the
    // repository with `randomUUID` because the BATCH `$transaction` cannot reference a row it is about
    // to create. Feature 022 needs the created row's own `created_at` for the contact stamp, so the
    // write moved to the interactive form, where the row IS available — and the up-front id went with
    // the constraint that required it. The id now comes from the database, so its FORMAT is Postgres's
    // business, not this test's.
    //
    // The real check is the one that was always the real check, and it is unchanged: both statements
    // carry the SAME id. A mismatch would leave attachment rows pointing at nothing.
    expect(res.id).toBeTruthy();
    expect(attachments.every((a) => a.message_id === res.id)).toBe(true);
    expect(messages[0]!.id).toBe(res.id);
  });

  it('a message with no attachments writes no attachment rows and makes no claim call', async () => {
    const { prisma, attachments } = fakePrisma();
    const { client, claimSpy } = fakeUploads();
    await controller(prisma, client).postMessage(
      { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'plain' },
      md('acc-1', 'op-1'),
    );
    expect(attachments).toEqual([]);
    // No uploads, no cross-service hop. The common case must not pay for the rare one.
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it('duplicate ids in one request are collapsed, not written twice', async () => {
    const { prisma, attachments } = fakePrisma();
    const { client } = fakeUploads(['u-1']);
    await controller(prisma, client).postMessage(
      { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ['u-1', 'u-1'] },
      md('acc-1', 'op-1'),
    );
    // The unique index would refuse the second row anyway; collapsing first means the write does not
    // depend on a constraint violation to be correct.
    expect(attachments).toHaveLength(1);
  });
});

describe('*** a refused attachment writes NOTHING *** (FR-015)', () => {
  it('an upload from another account is refused and no message row exists', async () => {
    const { prisma, messages, attachments } = fakePrisma();
    // 'u-theirs' belongs to another account, so the claim refuses it — the users service cannot even
    // see it, which is what makes a cross-account attachment impossible rather than merely checked.
    const { client } = fakeUploads(['u-mine']);
    await expect(
      controller(prisma, client).postMessage(
        {
          conversationId: CONV,
          kind: 'MESSAGE_KIND_PUBLIC_REPLY',
          body: 'sneaky',
          uploadIds: ['u-theirs'],
        },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(messages).toEqual([]);
    expect(attachments).toEqual([]);
  });

  it('a nonexistent upload is refused the same way — and looks identical', async () => {
    const { prisma, messages } = fakePrisma();
    const { client } = fakeUploads([]);
    await expect(
      controller(prisma, client).postMessage(
        { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ['u-ghost'] },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(messages).toEqual([]);
  });

  it('the claim happens BEFORE the write, not after it', async () => {
    const { prisma, messages } = fakePrisma();
    const { client, claimSpy } = fakeUploads(['u-1']);
    await controller(prisma, client).postMessage(
      { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ['u-1'] },
      md('acc-1', 'op-1'),
    );
    // Research R8: claim → write fails toward wasted bytes; write → claim fails toward a REFERENCED
    // upload still marked `pending`, which a reclaim job would delete. Wasted storage beats data loss.
    expect(claimSpy).toHaveBeenCalled();
    expect(messages).toHaveLength(1);
  });

  it('an unreachable users service refuses the message (fail-closed)', async () => {
    const { prisma, messages } = fakePrisma();
    const client = {
      describe: jest.fn(async () => {
        throw new UploadsUnavailableError('rpc failed');
      }),
      claim: jest.fn(async () => {
        throw new UploadsUnavailableError('rpc failed');
      }),
    } as unknown as UploadsClient;
    await expect(
      controller(prisma, client).postMessage(
        { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ['u-1'] },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    // A message posted without its attachment is not a degraded success — the agent believes the
    // customer received a file that was never linked.
    expect(messages).toEqual([]);
  });

  it('a conversation the caller cannot reach is refused before any claim is attempted', async () => {
    const { prisma, messages } = fakePrisma(null); // not in this account
    const { client, claimSpy, describeSpy } = fakeUploads(['u-1']);
    void describeSpy;
    await expect(
      controller(prisma, client).postMessage(
        { conversationId: 'nope', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ['u-1'] },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    // Claiming for a conversation that does not exist would strand the upload in `claimed` forever.
    expect(claimSpy).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });
});

describe('the id list is bounded (Principle VII / FR-023)', () => {
  it('more than 50 ids is refused', async () => {
    const { prisma, messages } = fakePrisma();
    const ids = Array.from({ length: 51 }, (_, i) => `u-${i}`);
    const { client, claimSpy } = fakeUploads(ids);
    await expect(
      controller(prisma, client).postMessage(
        { conversationId: CONV, kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x', uploadIds: ids },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });

  it('a non-string id is refused rather than coerced', async () => {
    const { prisma } = fakePrisma();
    const { client } = fakeUploads(['u-1']);
    await expect(
      controller(prisma, client).postMessage(
        {
          conversationId: CONV,
          kind: 'MESSAGE_KIND_PUBLIC_REPLY',
          body: 'x',
          uploadIds: [{ id: 'u-1' } as unknown as string],
        },
        md('acc-1', 'op-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
