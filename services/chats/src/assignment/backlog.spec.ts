import { BacklogRepository, firstServable, servesChannel, type BacklogItem } from './backlog';
import type { PrismaService } from '../prisma.service';

/**
 * T018–T021 (feature 031, roadmap 4.20 / ADR 0042 §1/§2) — the one ordered backlog.
 *
 * ⚠️ The skip rule is the ONLY place this feature deviates from strict FIFO, so it carries the most
 * assertions — including the one that matters most: a skipped item must keep its place.
 */

const item = (id: string, ms: number, channel: string | null = 'chat'): BacklogItem => ({
  id,
  channel,
  brand_id: 'b-1',
  routed_group_id: 'g-1',
  backlog_at: new Date(ms),
});

function fake() {
  const updateMany = jest.fn(async (args: unknown) => ({ count: 1, args }));
  const findMany = jest.fn(async (args: unknown) => (args ? [] : []));
  const conversation = { updateMany, findMany };
  const forAccount = jest.fn(() => ({ conversation }));
  const repo = new BacklogRepository({ forAccount } as unknown as PrismaService);
  return { repo, updateMany, findMany, forAccount };
}

describe('joining the backlog (T018)', () => {
  it('records the instant the wait started', async () => {
    const { repo, updateMany } = fake();
    const at = new Date('2026-08-04T10:00:00Z');
    await repo.enqueue('acc-1', 'c-1', at);
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ data: { backlog_at: at } });
  });

  it('⚠️ is IDEMPOTENT — the first instant wins, so a retry is not a demotion', async () => {
    // A full desk produces retries. An unconditional write would push the conversation to the back of its
    // own queue every time the router tried again.
    const { repo, updateMany } = fake();
    await repo.enqueue('acc-1', 'c-1', new Date());
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ where: { backlog_at: null } });
  });

  it('⛔ never enqueues something that already has an owner', async () => {
    const { repo, updateMany } = fake();
    await repo.enqueue('acc-1', 'c-1', new Date());
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ where: { assignee_operator_id: null } });
  });

  it('runs under the account-scoped client (Principle I)', async () => {
    const { repo, forAccount } = fake();
    await repo.enqueue('acc-42', 'c-1', new Date());
    expect(forAccount).toHaveBeenCalledWith('acc-42');
  });
});

describe('the order is stable (T019)', () => {
  it('reads oldest first, with id as the tie-break', async () => {
    const { repo, findMany } = fake();
    await repo.waiting('acc-1', 50);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      orderBy: [{ backlog_at: 'asc' }, { id: 'asc' }],
    });
  });

  it('⚠️ considers only rows that are still waiting AND still unowned', async () => {
    // FR-010: a conversation a person took while it was queued must never be assigned again by a drain.
    const { repo, findMany } = fake();
    await repo.waiting('acc-1', 50);
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { backlog_at: { not: null }, assignee_operator_id: null },
    });
  });

  it('is bounded — a drain does bounded work per freed unit', async () => {
    const { repo, findMany } = fake();
    await repo.waiting('acc-1', 25);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 25 });
  });
});

describe('⭐ the drain takes the first item it can SERVE (T020, research R5)', () => {
  const anyChat = (c: string | null) => c === 'chat';

  it('takes the head when the head fits', () => {
    const { pick, skipped } = firstServable([item('a', 1), item('b', 2)], anyChat);
    expect(pick?.id).toBe('a');
    expect(skipped).toEqual([]);
  });

  it('⭐ SKIPS an unservable head rather than blocking the queue behind it', () => {
    // The head-of-line case: a voice call nobody can take, with two chats waiting behind it. Strict FIFO
    // would stall the whole queue on an item that cannot move, and it would read as "the queue is stuck".
    const waiting = [item('voice-1', 1, 'voice'), item('chat-1', 2), item('chat-2', 3)];
    const { pick, skipped } = firstServable(waiting, anyChat);
    expect(pick?.id).toBe('chat-1');
    expect(skipped.map((s) => s.id)).toEqual(['voice-1']);
  });

  it('⚠️ a skipped item KEEPS ITS PLACE — nothing about it is rewritten', () => {
    // This is the assertion FR-008 actually rests on. The skip returns the item untouched; if a caller
    // ever "re-queued" it, that conversation would go to the back for the crime of being briefly
    // unservable, and could be overtaken for ever.
    const head = item('voice-1', 1, 'voice');
    const { skipped } = firstServable([head, item('chat-1', 2)], anyChat);
    expect(skipped[0]).toBe(head);
    expect(skipped[0]!.backlog_at).toEqual(new Date(1));
  });

  it('answers nothing when nothing fits, and reports everything it passed over', () => {
    const waiting = [item('v1', 1, 'voice'), item('v2', 2, 'voice')];
    const { pick, skipped } = firstServable(waiting, anyChat);
    expect(pick).toBeNull();
    expect(skipped).toHaveLength(2);
  });

  it('an empty backlog is a no-op, not an error', () => {
    expect(firstServable([], anyChat)).toEqual({ pick: null, skipped: [] });
  });
});

describe('what a freed unit can serve', () => {
  it('a single-unit channel fits one free unit', () => {
    expect(servesChannel('chat', 1, false)).toBe(true);
    expect(servesChannel('chat', 0, false)).toBe(false);
  });

  it('⚠️ an exclusive channel needs the agent HOLDING NOTHING, not merely having room', () => {
    // "Four units free" and "holding nothing" are different facts, and a voice call needs the second.
    expect(servesChannel('voice', 4, false)).toBe(false);
    expect(servesChannel('voice', 1, true)).toBe(true);
  });

  it('an absent channel costs a unit like any other work', () => {
    expect(servesChannel(null, 1, false)).toBe(true);
    expect(servesChannel(null, 0, false)).toBe(false);
  });
});

describe('leaving the backlog', () => {
  it('clears the wait when the conversation gains an owner by ANY route', async () => {
    const { repo, updateMany } = fake();
    await repo.dequeue('acc-1', 'c-1');
    expect(updateMany.mock.calls[0]![0]).toMatchObject({ data: { backlog_at: null } });
  });
});
