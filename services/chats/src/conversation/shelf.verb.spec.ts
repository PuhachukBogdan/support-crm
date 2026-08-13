import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import type { DomainEventPublisher } from '../events/events.publisher';
import type { AuditRepository } from '../audit/audit.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import { fakeStatusRepository } from '../status/status.fixture';
import { fakeRealtime } from '../realtime/realtime.fake';
import { noInboxUnseen, noOperatorIdentity } from '../shared/operator-identity.fake';

/**
 * ⭐ W27 / 036 — `SetConversationShelf` as BEHAVIOUR (FR-005/006/007/008/010/011).
 *
 * The table itself is `shelf.spec.ts`'s claim; here it is the controller's use of it: what lands in
 * the database, what lands in the audit trail, what is refused, and — FR-006's structural half —
 * that a restore writes the trio back to NULL and NOTHING else.
 */

function md(accountId = 'acc-1', userId = 'sup-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-effective-role', 'teamlead');
  return m;
}

const ROW = {
  id: 'c-1',
  brand_id: 'brand-a',
  player_id: 'p-1',
  status: 'open',
  priority: null as string | null,
  priority_rank: 0,
  assignee_operator_id: 'op-agent',
  channel: 'email',
  created_at: new Date('2026-08-12T09:00:00.000Z'),
  updated_at: new Date('2026-08-12T09:00:00.000Z'),
  reference: '17',
  category: null,
  sub_category: null,
  classified_by: null,
  subject: 'held for review',
  subject_source: 'source',
  shelved_state: null as string | null,
};

function fixture(shelved: string | null = null, exists = true) {
  const row = { ...ROW, shelved_state: shelved };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const transactions: unknown[][] = [];

  const scoped = {
    conversation: {
      findFirst: jest.fn(() => Promise.resolve(exists ? { ...row } : null)),
      updateMany: jest.fn(
        (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updates.push(args);
          // Honour the state-guarded where the repository sends (the race rule).
          if (!exists || ('shelved_state' in args.where && args.where.shelved_state !== row.shelved_state)) {
            return Promise.resolve({ count: 0 });
          }
          Object.assign(row, args.data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    conversationTransition: { create: jest.fn(() => Promise.resolve({})) },
  } as Record<string, unknown>;
  (scoped as { $transaction: unknown }).$transaction = (arg: unknown) => {
    if (Array.isArray(arg)) {
      transactions.push(arg);
      return Promise.all(arg);
    }
    return (arg as (tx: unknown) => Promise<unknown>)(scoped);
  };

  const prisma = { forAccount: jest.fn().mockReturnValue(scoped) } as unknown as PrismaService;

  const auditCalls: Array<Record<string, unknown>> = [];
  const audit = {
    statement: jest.fn((_account: string, input: Record<string, unknown>) => {
      auditCalls.push(input);
      return Promise.resolve({ audit: input.action });
    }),
  } as unknown as AuditRepository;

  const noEvents = {} as DomainEventPublisher; // the shelf is not an automation trigger
  const realtime = fakeRealtime();
  const controller = new ConversationWriteController(
    new ConversationRepository(prisma, new TransitionRecorder()),
    noEvents,
    fakeStatusRepository(),
    audit,
    realtime.publisher,
    noInboxUnseen(),
    noOperatorIdentity(),
  );
  return { controller, row, updates, transactions, auditCalls, realtime, prisma };
}

describe('⭐ SetConversationShelf — the four verbs through one rpc', () => {
  it('suspend: writes the trio, audits conversation.suspend IN the same transaction, tells the sockets', async () => {
    const f = fixture();
    const res = await f.controller.setConversationShelf({ conversationId: 'c-1', state: 'suspended' }, md());

    expect(res.changed).toBe(true);
    expect(res.conversation.shelvedState).toBe('suspended');
    const write = f.updates[0]!;
    expect(write.where).toEqual({ id: 'c-1', shelved_state: null }); // the race rule: expected FROM
    expect(write.data).toMatchObject({ shelved_state: 'suspended', shelved_by: 'sup-1' });
    expect(f.auditCalls[0]).toMatchObject({
      action: 'conversation.suspend',
      targetRef: 'c-1',
      detail: { fromState: '', toState: 'suspended' },
    });
    // One transaction, two statements: the act and its entry succeed together (FR-008).
    expect(f.transactions[0]).toHaveLength(2);
    expect(f.realtime.published).toContainEqual(expect.objectContaining({ kind: 'conversation.updated' }));
  });

  it('⭐ restore writes the trio back to NULL and NOTHING else — "exactly as it was" is structural (FR-006)', async () => {
    const f = fixture('deleted');
    const res = await f.controller.setConversationShelf({ conversationId: 'c-1', state: '' }, md());

    expect(res.changed).toBe(true);
    // The exact data object: three keys, all null. A fourth key here would be a restore that edits.
    expect(f.updates[0]!.data).toEqual({ shelved_state: null, shelved_at: null, shelved_by: null });
    expect(f.auditCalls[0]).toMatchObject({ action: 'conversation.restore' });
    expect(f.row.assignee_operator_id).toBe('op-agent'); // untouched, like everything else
  });

  it('release is its own audit word — undoing a suspension is not "restoring a deletion"', async () => {
    const f = fixture('suspended');
    await f.controller.setConversationShelf({ conversationId: 'c-1', state: '' }, md());
    expect(f.auditCalls[0]).toMatchObject({ action: 'conversation.release' });
  });

  it('⭐ same→same answers changed:false and writes NOTHING — no update, no audit entry (FR-010)', async () => {
    const f = fixture('suspended');
    const res = await f.controller.setConversationShelf({ conversationId: 'c-1', state: 'suspended' }, md());
    expect(res.changed).toBe(false);
    expect(f.updates).toHaveLength(0);
    expect(f.auditCalls).toHaveLength(0);
  });

  it('⛔ deleted → suspended is refused; delete over suspended wins with the delete word', async () => {
    const f1 = fixture('deleted');
    await expect(
      f1.controller.setConversationShelf({ conversationId: 'c-1', state: 'suspended' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.FAILED_PRECONDITION } });
    expect(f1.updates).toHaveLength(0);

    const f2 = fixture('suspended');
    await f2.controller.setConversationShelf({ conversationId: 'c-1', state: 'deleted' }, md());
    expect(f2.auditCalls[0]).toMatchObject({ action: 'conversation.delete' });
  });

  it('an unknown state is refused, and an unknown conversation is NOT_FOUND before any write', async () => {
    const f = fixture();
    await expect(
      f.controller.setConversationShelf({ conversationId: 'c-1', state: 'archived' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });

    const gone = fixture(null, false);
    await expect(
      gone.controller.setConversationShelf({ conversationId: 'c-x', state: 'suspended' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.NOT_FOUND } });
    expect(gone.auditCalls).toHaveLength(0);
  });

  it('tenant isolation: every read and write runs under the CALLER’s account scope', async () => {
    const f = fixture();
    await f.controller.setConversationShelf({ conversationId: 'c-1', state: 'suspended' }, md('acc-9'));
    for (const call of (f.prisma.forAccount as jest.Mock).mock.calls) {
      expect(call[0]).toBe('acc-9');
    }
  });
});

describe('⭐ the mutation freeze — while shelved, the only verb is the shelf rpc (FR-007)', () => {
  it('a status write on a shelved conversation is FAILED_PRECONDITION, before any write', async () => {
    const f = fixture('suspended');
    await expect(
      f.controller.setConversationStatus({ conversationId: 'c-1', statusKey: 'solved' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.FAILED_PRECONDITION } });
    expect(f.updates).toHaveLength(0);
  });

  it('…and a priority write the same — the guard is one helper, not a per-verb reflex', async () => {
    const f = fixture('deleted');
    await expect(
      f.controller.setConversationPriority({ conversationId: 'c-1', priority: 'high' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.FAILED_PRECONDITION } });
    expect(f.updates).toHaveLength(0);
  });
});
