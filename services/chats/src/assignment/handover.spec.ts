import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { HandoverRepository, type OpenWorkRow } from './handover.repository';
import { HandoverMaintenanceController } from './handover.grpc.controller';
import type { ChannelRepository, ChannelRow } from '../channel/channel.repository';
import type { StatusRepository } from '../status/status.repository';
import type { AuditRepository } from '../audit/audit.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import { systemActor } from '../transition/conversation-transitions';
import { fakeRealtime } from '../realtime/realtime.fake';

/**
 * T030 (W31 / feature 038 — ADR 0043 §4, SEC-PV2): **a departed colleague's work goes back.**
 *
 * ⭐ The assertion this whole file exists for is the first one: after the handover a conversation is
 * BOTH unassigned AND stamped `backlog_at`. Half the operation is the trap the product already
 * contains — `AssignConversation('')` nulls the assignee and nothing else, and the drain only ever
 * looks at rows carrying a stamp — so a handover doing only that would leave a ticket that is
 * nobody's AND invisible, with a perfectly green test proving «unassigned».
 */

const AT = new Date('2026-08-13T09:00:00.000Z');

const system = () => {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  return md;
};

// ── The repository, against a fake Prisma ────────────────────────────────────────────────────────

const beforeRow = (over: Record<string, unknown> = {}) => ({
  id: 'c-1',
  status: 'open',
  brand_id: 'b-1',
  channel: 'email',
  assignee_operator_id: 'op-gone',
  form_key: null,
  backlog_at: null as Date | null,
  ...over,
});

function fakeDb(before: ReturnType<typeof beforeRow> | null) {
  const conversation = {
    findFirst: jest.fn().mockResolvedValue(before),
    updateMany: jest.fn().mockResolvedValue({ count: before ? 1 : 0 }),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  const conversationTransition = { create: jest.fn() };
  const client = { conversation, conversationTransition, $transaction: (fn: (tx: unknown) => unknown) => fn(client) };
  // Wrapped so the spec can assert that BOTH writes rode ONE transaction rather than two.
  const $transaction = jest.fn(client.$transaction);
  const forAccount = jest.fn().mockReturnValue({ ...client, $transaction });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    conversationTransition,
    $transaction,
    forAccount,
  };
}

const repoOf = (prisma: PrismaService) => new HandoverRepository(prisma, new TransitionRecorder());

describe('HandoverRepository.returnToBacklog', () => {
  it('⭐ unassigns AND enqueues in ONE transaction — the drain can see it afterwards', async () => {
    const { prisma, conversation, $transaction } = fakeDb(beforeRow());

    const moved = await repoOf(prisma).returnToBacklog(
      'acc-1',
      'c-1',
      'op-gone',
      'desk-a',
      AT,
      systemActor('staff-handover'),
    );

    expect(moved).toBe(true);
    expect($transaction).toHaveBeenCalledTimes(1);
    const { data } = conversation.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    // Both halves. Either one alone is the SEC-PV2 failure.
    expect(data.assignee_operator_id).toBeNull();
    expect(data.backlog_at).toEqual(AT);
    expect(data.routed_group_id).toBe('desk-a');
  });

  it('⭐ writes the transition with a SYSTEM actor that names itself', async () => {
    const { prisma, conversationTransition } = fakeDb(beforeRow());

    await repoOf(prisma).returnToBacklog('acc-1', 'c-1', 'op-gone', 'desk-a', AT, systemActor('staff-handover'));

    const { data } = conversationTransition.create.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.type).toBe('conversation.assigned');
    expect(data.actor_kind).toBe('system');
    expect(data.actor_ref).toBe('staff-handover');
    // The trail says whose work this was and that it now belongs to nobody.
    expect(data.payload_json).toEqual({ from: 'op-gone', to: null });
  });

  it('⚠️ a conversation already in line KEEPS its place — the stamp is not rewritten', async () => {
    // Rewriting it would demote the ticket for the crime of its owner leaving (the enqueue rule).
    const waited = new Date('2026-08-01T00:00:00.000Z');
    const { prisma, conversation } = fakeDb(beforeRow({ backlog_at: waited }));

    await repoOf(prisma).returnToBacklog('acc-1', 'c-1', 'op-gone', 'desk-a', AT, systemActor('staff-handover'));

    const { data } = conversation.updateMany.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(data.backlog_at).toEqual(waited);
  });

  it('⛔ writes NOTHING when the ticket is no longer this operator\'s (idempotence, and the race)', async () => {
    // A second run, or a supervisor who reassigned it in between. Both must leave the row alone.
    const { prisma, conversation, conversationTransition } = fakeDb(null);

    const moved = await repoOf(prisma).returnToBacklog('acc-1', 'c-1', 'op-gone', 'desk-a', AT, systemActor('staff-handover'));

    expect(moved).toBe(false);
    expect(conversation.updateMany).not.toHaveBeenCalled();
    expect(conversationTransition.create).not.toHaveBeenCalled();
  });

  it('⛔ the departed operator is in the WRITE predicate, not only in the read', async () => {
    const { prisma, conversation } = fakeDb(beforeRow());
    await repoOf(prisma).returnToBacklog('acc-1', 'c-1', 'op-gone', 'desk-a', AT, systemActor('staff-handover'));
    const { where } = conversation.updateMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(where).toEqual({ id: 'c-1', assignee_operator_id: 'op-gone' });
  });

  it('⛔ every read and write goes through forAccount — never the raw client (Principle I)', async () => {
    const { prisma, forAccount } = fakeDb(beforeRow());
    const repo = repoOf(prisma);
    await repo.openWorkOf('acc-9', 'op-gone', ['open'], 50);
    await repo.countOpenWorkOf('acc-9', 'op-gone', ['open']);
    await repo.countShelvedWorkOf('acc-9', 'op-gone', ['open']);
    await repo.returnToBacklog('acc-9', 'c-1', 'op-gone', 'desk-a', AT, systemActor('staff-handover'));
    expect(forAccount.mock.calls.map((c) => c[0])).toEqual(['acc-9', 'acc-9', 'acc-9', 'acc-9']);
  });

  it('⛔ shelved work is excluded at the front door, and counted separately', async () => {
    const { prisma, conversation } = fakeDb(beforeRow());
    const repo = repoOf(prisma);
    await repo.openWorkOf('acc-1', 'op-gone', ['open', 'pending'], 50);
    await repo.countShelvedWorkOf('acc-1', 'op-gone', ['open', 'pending']);

    const selected = conversation.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(selected.where).toMatchObject({ assignee_operator_id: 'op-gone', shelved_state: null });
    const counted = conversation.count.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect(counted.where).toMatchObject({ shelved_state: { not: null } });
  });
});

// ── The rpc ──────────────────────────────────────────────────────────────────────────────────────

const work = (id: string, over: Partial<OpenWorkRow> = {}): OpenWorkRow => ({
  id,
  brand_id: 'b-1',
  channel: 'email',
  routed_group_id: 'desk-a',
  backlog_at: null,
  ...over,
});

const channel = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: 'ch-1',
  account_id: 'acc-1',
  brand_id: 'b-1',
  kind: 'email',
  key: 'k',
  address: null,
  default_group_id: 'desk-mail',
  enabled: true,
  ...over,
});

function build(opts: {
  rows?: OpenWorkRow[];
  total?: number;
  shelved?: number;
  channels?: ChannelRow[];
  statusKeys?: string[];
  moves?: boolean[];
}) {
  const rows = opts.rows ?? [];
  const answers = [...(opts.moves ?? [])];
  // Typed with the arguments the assertions read back (the drain spec's own shape): a `jest.fn` with
  // no declared parameters records an EMPTY tuple, so `calls[0][3]` would not compile.
  const openWorkOf = jest.fn(
    async (accountId: string, operatorId: string, statusKeys: readonly string[], limit: number) => {
      void accountId;
      void operatorId;
      void statusKeys;
      void limit;
      return rows;
    },
  );
  const countOpenWorkOf = jest.fn(
    async (accountId: string, operatorId: string, statusKeys: readonly string[]) => {
      void accountId;
      void operatorId;
      void statusKeys;
      return opts.total ?? rows.length;
    },
  );
  const countShelvedWorkOf = jest.fn(async () => opts.shelved ?? 0);
  const returnToBacklog = jest.fn(
    async (
      accountId: string,
      conversationId: string,
      operatorId: string,
      deskId: string,
      at: Date,
      actor: unknown,
    ) => {
      void accountId;
      void conversationId;
      void operatorId;
      void deskId;
      void at;
      void actor;
      return answers.length > 0 ? answers.shift()! : true;
    },
  );
  const nonTerminalKeys = jest.fn(async () => opts.statusKeys ?? ['open', 'pending']);
  const listForAccount = jest.fn(async () => opts.channels ?? []);
  const append = jest.fn(async (accountId: string, entry: Record<string, unknown>) => {
    void accountId;
    void entry;
  });
  const realtime = fakeRealtime();

  const controller = new HandoverMaintenanceController(
    { openWorkOf, countOpenWorkOf, countShelvedWorkOf, returnToBacklog } as unknown as HandoverRepository,
    { nonTerminalKeys } as unknown as StatusRepository,
    { listForAccount } as unknown as ChannelRepository,
    { append } as unknown as AuditRepository,
    realtime.publisher,
  );
  return { controller, openWorkOf, countOpenWorkOf, returnToBacklog, append, realtime, nonTerminalKeys };
}

const call = (c: HandoverMaintenanceController, over: Record<string, unknown> = {}) =>
  c.returnOperatorWorkToBacklog({ accountId: 'acc-1', operatorId: 'op-gone', ...over }, system());

describe('ReturnOperatorWorkToBacklog', () => {
  it('moves every open, non-shelved conversation and reports counts', async () => {
    const { controller, returnToBacklog } = build({ rows: [work('c-1'), work('c-2')] });

    const res = await call(controller);

    expect(res).toMatchObject({ moved: 2, noDesk: 0, remaining: 0 });
    expect(returnToBacklog).toHaveBeenCalledTimes(2);
    // The desk the router had already chosen is the first choice of destination.
    expect(returnToBacklog.mock.calls[0]![3]).toBe('desk-a');
  });

  it('⭐ NO DESK ⇒ the owner is KEPT and the ticket is counted, never quietly unassigned', async () => {
    // «Nobody's and unqueued» is the state this rpc exists to prevent — so a ticket whose destination
    // cannot be resolved is left exactly as it is, and reported.
    const { controller, returnToBacklog } = build({
      rows: [work('c-1', { routed_group_id: null, channel: null })],
    });

    const res = await call(controller);

    expect(res).toMatchObject({ moved: 0, noDesk: 1 });
    expect(returnToBacklog).not.toHaveBeenCalled();
  });

  it('falls back to the DESK OF THE CHANNEL when the ticket was never routed', async () => {
    const { controller, returnToBacklog } = build({
      rows: [work('c-1', { routed_group_id: null })],
      channels: [channel()],
    });

    const res = await call(controller);

    expect(res).toMatchObject({ moved: 1, noDesk: 0 });
    expect(returnToBacklog.mock.calls[0]![3]).toBe('desk-mail');
  });

  it('⚠️ a channel that names no desk is an absence, not a default — counted as no_desk', async () => {
    const { controller } = build({
      rows: [work('c-1', { routed_group_id: null })],
      channels: [channel({ default_group_id: null })],
    });
    await expect(call(controller)).resolves.toMatchObject({ moved: 0, noDesk: 1 });
  });

  it('⚠️ another BRAND\'s channel is not a destination', async () => {
    // The desk is resolved per (brand, kind), which is how the Channel table is keyed. Matching on the
    // kind alone would push one brand's ticket onto another brand's desk.
    const { controller } = build({
      rows: [work('c-1', { routed_group_id: null, brand_id: 'b-2' })],
      channels: [channel()],
    });
    await expect(call(controller)).resolves.toMatchObject({ moved: 0, noDesk: 1 });
  });

  it('shelved work is reported as skipped rather than moved', async () => {
    const { controller, returnToBacklog } = build({ rows: [work('c-1')], shelved: 3 });
    const res = await call(controller);
    expect(res).toMatchObject({ moved: 1, skippedShelved: 3 });
    expect(returnToBacklog).toHaveBeenCalledTimes(1);
  });

  it('the batch is server-capped and the remainder is REPORTED, never dropped', async () => {
    const { controller, openWorkOf } = build({ rows: [work('c-1')], total: 140 });

    const res = await call(controller, { limit: 10_000 });

    expect(openWorkOf.mock.calls[0]![3]).toBeLessThanOrEqual(100);
    expect(res).toMatchObject({ moved: 1, remaining: 139 });
  });

  it('⭐ a repeat is a no-op: nothing left to move, nothing new on the record', async () => {
    // Idempotence is by predicate — the moved rows are no longer assigned to the departed operator,
    // so the second call selects none of them (research D5: the handover is re-runnable on purpose).
    const { controller, append, returnToBacklog } = build({ rows: [], total: 0 });

    const res = await call(controller);

    expect(res).toMatchObject({ moved: 0, noDesk: 0, remaining: 0 });
    expect(returnToBacklog).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('⭐ ONE audited `staff.handover` entry, with counts and no conversation', async () => {
    const { controller, append } = build({
      rows: [work('c-secret'), work('c-2', { routed_group_id: null, channel: null })],
    });

    const res = await call(controller);

    expect(append).toHaveBeenCalledTimes(1);
    const [accountId, entry] = append.mock.calls[0]! as unknown as [string, Record<string, unknown>];
    expect(accountId).toBe('acc-1');
    expect(entry.action).toBe('staff.handover');
    expect(entry.actorKind).toBe('system');
    expect(entry.targetRef).toBe('op-gone');
    expect(entry.detail).toEqual({ movedCount: 1, noDeskCount: 1 });
    // Counts only — a conversation id in a staffing trail is customer work in a log read for other
    // reasons (Principle IV).
    expect(JSON.stringify(res)).not.toContain('c-secret');
    expect(Object.keys(res).sort()).toEqual(['moved', 'noDesk', 'remaining', 'skippedShelved']);
  });

  it('publishes conversation.updated for what actually moved, and only that', async () => {
    const { controller, realtime } = build({
      rows: [work('c-1'), work('c-2')],
      moves: [true, false], // the second was reassigned by a human in between
    });

    const res = await call(controller);

    expect(res).toMatchObject({ moved: 1 });
    expect(realtime.published).toEqual([
      { kind: 'conversation.updated', accountId: 'acc-1', conversationId: 'c-1' },
    ]);
  });

  it('⛔ a USER session cannot hand over a colleague\'s work, however broad its permissions', async () => {
    const { controller, openWorkOf } = build({ rows: [work('c-1')] });
    const user = new Metadata();
    user.set('x-actor-account-id', 'acc-1');
    user.set('x-actor-user-id', 'u-1');
    user.set('x-actor-permissions', 'crm.conversation.assign,platform.audit.view');
    await expect(
      controller.returnOperatorWorkToBacklog({ accountId: 'acc-1', operatorId: 'op-gone' }, user),
    ).rejects.toBeDefined();
    expect(openWorkOf).not.toHaveBeenCalled();
  });

  it('⛔ refuses an absent account or operator rather than defaulting to one', async () => {
    // A machine has no account of its own; defaulting one would empty a queue in the wrong tenant.
    const { controller, openWorkOf } = build({ rows: [work('c-1')] });
    await expect(controller.returnOperatorWorkToBacklog({ operatorId: 'op-gone' }, system())).rejects.toBeDefined();
    await expect(controller.returnOperatorWorkToBacklog({ accountId: 'acc-1' }, system())).rejects.toBeDefined();
    expect(openWorkOf).not.toHaveBeenCalled();
  });

  it('⭐ every read and write runs under the account NAMED IN THE REQUEST (isolation)', async () => {
    const { controller, openWorkOf, countOpenWorkOf, returnToBacklog, append } = build({ rows: [work('c-1')] });

    await call(controller, { accountId: 'acc-42' });

    expect(openWorkOf.mock.calls[0]![0]).toBe('acc-42');
    expect(countOpenWorkOf.mock.calls[0]![0]).toBe('acc-42');
    expect(returnToBacklog.mock.calls[0]![0]).toBe('acc-42');
    expect(append.mock.calls[0]![0]).toBe('acc-42');
  });

  it('⛔ an account with NO non-terminal status is refused, not answered with zero', async () => {
    // An empty `in` predicate matches nothing, so the quiet version would report «held no open work»
    // about somebody holding all of it — our own query producing the SEC-PV2 shape.
    const { controller, openWorkOf } = build({ rows: [work('c-1')], statusKeys: [] });
    await expect(call(controller)).rejects.toBeDefined();
    expect(openWorkOf).not.toHaveBeenCalled();
  });
});
