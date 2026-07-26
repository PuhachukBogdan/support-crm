import {
  conversationCreatedKey,
  firstReplyBreachedKey,
  isAutomationTrigger,
  messageReceivedKey,
  statusChangedKey,
} from './events.types';
import { DomainEventDispatcher } from './events.dispatcher';
import type { DomainEvent } from './events.types';

/**
 * T011 (feature 014) — the event layer. FAILS before the module exists, PASSES after.
 *
 * `event_key` carries the at-most-once guarantee together with the unique index on
 * (automation_id, conversation_id, event_key) — research R6. So the two properties worth asserting
 * are exactly: **same occurrence ⇒ same key** (a redelivery cannot double-apply) and **different
 * occurrence ⇒ different key** (a genuine repeat is not swallowed).
 */
const facts = {
  status: 'open',
  priority: null,
  brandId: 'b1',
  channel: 'web',
  hasAssignee: false,
  labelIds: [],
};

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
  accountId: 'acc-1',
  conversationId: 'c1',
  eventKey: messageReceivedKey('m1'),
  facts,
  ...over,
});

describe('event_key determinism (FR-008 / research R6)', () => {
  it('is stable for the same occurrence', () => {
    expect(messageReceivedKey('m1')).toBe(messageReceivedKey('m1'));
    expect(conversationCreatedKey('c1')).toBe(conversationCreatedKey('c1'));
    const at = new Date('2026-07-27T10:00:00.000Z');
    expect(statusChangedKey('c1', 'pending', at)).toBe(statusChangedKey('c1', 'pending', at));
  });

  it('differs across occurrences', () => {
    expect(messageReceivedKey('m1')).not.toBe(messageReceivedKey('m2'));
    expect(conversationCreatedKey('c1')).not.toBe(conversationCreatedKey('c2'));
    const t1 = new Date('2026-07-27T10:00:00.000Z');
    const t2 = new Date('2026-07-27T10:00:01.000Z');
    // Same target status, later write ⇒ a genuinely new occurrence.
    expect(statusChangedKey('c1', 'pending', t1)).not.toBe(statusChangedKey('c1', 'pending', t2));
    // Same instant, different resulting status ⇒ also distinct.
    expect(statusChangedKey('c1', 'pending', t1)).not.toBe(statusChangedKey('c1', 'resolved', t1));
  });

  it('never collides across trigger kinds for the same conversation id', () => {
    const keys = new Set([
      conversationCreatedKey('x'),
      messageReceivedKey('x'),
      statusChangedKey('x', 'open', new Date(0)),
      firstReplyBreachedKey('x'),
    ]);
    expect(keys.size).toBe(4);
  });

  // A conversation breaches its FIRST-reply target once, ever — so the key must NOT vary with time.
  it('breach key is timestamp-free so a re-sweep cannot re-announce it', () => {
    expect(firstReplyBreachedKey('c1')).toBe('breach:c1');
    expect(firstReplyBreachedKey('c1')).toBe(firstReplyBreachedKey('c1'));
  });
});

describe('isAutomationTrigger', () => {
  it('accepts the four v1 triggers and refuses anything else', () => {
    expect(isAutomationTrigger('AUTOMATION_TRIGGER_MESSAGE_RECEIVED')).toBe(true);
    expect(isAutomationTrigger('AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED')).toBe(true);
    for (const bad of [
      'AUTOMATION_TRIGGER_UNSPECIFIED',
      'MESSAGE_RECEIVED',
      'AUTOMATION_TRIGGER_MESSAGE_SENT',
      '',
      undefined,
      42,
    ]) {
      expect(isAutomationTrigger(bad)).toBe(false);
    }
  });
});

describe('DomainEventDispatcher', () => {
  it('delivers to every subscriber and sums what they applied', async () => {
    const d = new DomainEventDispatcher();
    d.subscribe(async () => 2);
    d.subscribe(async () => 3);
    await expect(d.publish(event())).resolves.toBe(5);
  });

  // A broken rule must not fail the human action that triggered it.
  it('swallows a throwing subscriber and still delivers to the rest', async () => {
    const d = new DomainEventDispatcher();
    const after = jest.fn(async () => 1);
    d.subscribe(async () => {
      throw new Error('rule blew up');
    });
    d.subscribe(after);
    await expect(d.publish(event())).resolves.toBe(1);
    expect(after).toHaveBeenCalled();
  });

  it('is a no-op with no subscribers', async () => {
    await expect(new DomainEventDispatcher().publish(event())).resolves.toBe(0);
  });

  it('never logs message text (Principle IV) when a subscriber fails', async () => {
    const d = new DomainEventDispatcher();
    const warn = jest.spyOn((d as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    d.subscribe(async () => {
      throw new Error('boom');
    });
    await d.publish(
      event({ facts: { ...facts, messageText: 'my card number is 4111 1111 1111 1111' } }),
    );
    const logged = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('AUTOMATION_TRIGGER_MESSAGE_RECEIVED');
    expect(logged).not.toContain('4111');
    expect(logged).not.toContain('card number');
  });
});
