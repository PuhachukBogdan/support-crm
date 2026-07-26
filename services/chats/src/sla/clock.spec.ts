import { FirstReplyClock } from './first-reply.clock';
import type { SlaRepository } from './sla.repository';
import type { ConversationRepository } from '../conversation/conversation.repository';

/**
 * T040 (feature 014, US2) — the clock driver that the message edges call. FAILS before it exists.
 *
 * `first-reply.spec.ts` proves the decisions; this proves the wiring, and the wiring has two properties
 * worth pinning:
 *  • a **private note** reaches this class and resolves to no write. The rule lives in one place
 *    (`decideStop`) rather than at each call site, so it cannot be forgotten on a future write path.
 *  • a failure here **never** propagates. The SLA is an observation of the conversation; a broken
 *    observation must not fail the operator's actual message.
 */
const conversation = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  brand_id: 'b1',
  player_id: 'p1',
  status: 'open',
  priority: 'normal',
  assignee_operator_id: null,
  channel: 'web',
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  created_at: new Date('2026-07-27T10:00:00.000Z'),
  updated_at: new Date('2026-07-27T10:00:00.000Z'),
  ...over,
});

const runningState = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  conversation_id: 'c1',
  outcome: 'running' as const,
  started_at: new Date('2026-07-27T10:00:00.000Z'),
  deadline_at: new Date('2026-07-27T10:10:00.000Z'),
  target_minutes: 10,
  first_reply_at: null,
  first_reply_seconds: null,
  breach_announced_at: null,
  ...over,
});

function build(opts: {
  state?: unknown;
  policies?: unknown[];
  conv?: unknown;
  getStateThrows?: boolean;
} = {}) {
  const getState = jest.fn(async () => {
    if (opts.getStateThrows) throw new Error('db down');
    return (opts.state ?? null) as never;
  });
  const listPolicies = jest.fn(async () => (opts.policies ?? [
    { id: 'p', target_minutes: 10, scope_priority: '*', scope_brand_id: '*' },
  ]) as never);
  const start = jest.fn(async () => undefined);
  const stop = jest.fn(async () => undefined);
  const getById = jest.fn(async () => (opts.conv === undefined ? conversation() : opts.conv) as never);

  const clock = new FirstReplyClock(
    { getState, listPolicies, start, stop } as unknown as SlaRepository,
    { getById } as unknown as ConversationRepository,
  );
  return { clock, getState, listPolicies, start, stop, getById };
}

describe('onInboundPlayerMessage', () => {
  it('starts a clock with the resolved target', async () => {
    const { clock, start } = build();
    await clock.onInboundPlayerMessage('acc-1', 'c1');
    expect(start).toHaveBeenCalledWith(
      'acc-1',
      'c1',
      expect.objectContaining({ target_minutes: 10 }),
    );
  });

  it('does NOT restart an existing clock (a chatty player cannot reset the deadline)', async () => {
    const { clock, start, listPolicies } = build({ state: runningState() });
    await clock.onInboundPlayerMessage('acc-1', 'c1');
    expect(start).not.toHaveBeenCalled();
    expect(listPolicies).not.toHaveBeenCalled(); // and it does not even look up a policy
  });

  it('starts nothing when the account has no policy (absence is not a zero target)', async () => {
    const { clock, start } = build({ policies: [] });
    await clock.onInboundPlayerMessage('acc-1', 'c1');
    expect(start).not.toHaveBeenCalled();
  });

  it('resolves the target against the conversation’s own brand + priority', async () => {
    const { clock, start } = build({
      conv: conversation({ priority: 'high', brand_id: 'b9' }),
      policies: [
        { id: 'a', target_minutes: 30, scope_priority: '*', scope_brand_id: '*' },
        { id: 'b', target_minutes: 5, scope_priority: 'high', scope_brand_id: '*' },
      ],
    });
    await clock.onInboundPlayerMessage('acc-1', 'c1');
    expect(start).toHaveBeenCalledWith('acc-1', 'c1', expect.objectContaining({ target_minutes: 5 }));
  });

  it('does nothing when the conversation is gone', async () => {
    const { clock, start } = build({ conv: null });
    await clock.onInboundPlayerMessage('acc-1', 'c1');
    expect(start).not.toHaveBeenCalled();
  });

  it('swallows a failure — the player’s message must still be recorded', async () => {
    const { clock } = build({ getStateThrows: true });
    await expect(clock.onInboundPlayerMessage('acc-1', 'c1')).resolves.toBeUndefined();
  });
});

describe('onStaffMessage', () => {
  it('*** a private note reaches the clock and writes NOTHING (FR-012 / SC-007) ***', async () => {
    const { clock, stop } = build({ state: runningState() });
    await clock.onStaffMessage('acc-1', 'c1', false);
    expect(stop).not.toHaveBeenCalled();
  });

  it('a public reply stops the clock', async () => {
    const { clock, stop } = build({ state: runningState() });
    await clock.onStaffMessage('acc-1', 'c1', true);
    expect(stop).toHaveBeenCalledWith(
      'acc-1',
      'c1',
      expect.objectContaining({ outcome: expect.stringMatching(/met|breached/) }),
    );
  });

  it('does nothing when there is no clock', async () => {
    const { clock, stop } = build({ state: null });
    await clock.onStaffMessage('acc-1', 'c1', true);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does nothing for an already-decided measurement', async () => {
    const { clock, stop } = build({ state: runningState({ outcome: 'met' }) });
    await clock.onStaffMessage('acc-1', 'c1', true);
    expect(stop).not.toHaveBeenCalled();
  });

  it('swallows a failure — the operator’s reply must still be posted', async () => {
    const { clock } = build({ getStateThrows: true });
    await expect(clock.onStaffMessage('acc-1', 'c1', true)).resolves.toBeUndefined();
  });
});
