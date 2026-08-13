import { AutomationEngine } from './engine';
import { DomainEventDispatcher } from '../events/events.dispatcher';
import { statusChangedKey } from '../events/events.types';
import type { AutomationsRepository } from './automations.repository';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { LabelsRepository } from '../labels/labels.repository';
import type { DomainEvent } from '../events/events.types';
import { fakeStatusRepository } from '../status/status.fixture';

/**
 * T018 (feature 014, US1) — **SC-004: no configuration of rules can produce an unbounded reaction
 * chain.** FAILS if the engine ever gains a path that re-publishes.
 *
 * The fixture is the worst case on purpose: a rule triggered by `status_changed` whose action is
 * `SET_STATUS`. Under a naive design it re-satisfies its own trigger, and the loop is unbounded
 * writes against a real conversation.
 *
 * It cannot loop here because of a *structural* choice, not a counter: only controllers publish, and
 * the engine writes through repositories that cannot publish (research R4). This spec pins that down
 * from the outside — it wires a real dispatcher, lets the engine run, and asserts the dispatcher was
 * never re-entered. A companion spec (`events/no-publish-from-repositories.spec.ts`) polices the
 * imports so the property cannot be quietly removed.
 */
const TRIGGER = 'AUTOMATION_TRIGGER_STATUS_CHANGED' as const;

const SELF_SATISFYING = {
  trigger: TRIGGER,
  conditions: [],
  actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }],
};

const selfRule = {
  id: 'r-self',
  name: 'self-satisfying',
  active: true,
  position: 0,
  revision: 1,
  author_user_id: 'author-1',
  definition: SELF_SATISFYING,
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
};

const statusEvent = (): DomainEvent => ({
  trigger: TRIGGER,
  accountId: 'acc-1',
  conversationId: 'c1',
  eventKey: statusChangedKey('c1', 'open', new Date('2026-07-27T12:00:00Z')),
  facts: {
    status: 'open',
    priority: null,
    brandId: 'b1',
    channel: 'web',
    hasAssignee: false,
    labelIds: [],
    // Feature 024: unscoped work — no desk took it. Required, so the compiler names every fixture.
    routedGroupId: null,
  },
});

describe('no cascade (FR-006 / SC-004)', () => {
  it('a self-satisfying rule applies exactly ONCE and never re-enters the dispatcher', async () => {
    const applyWithRun = jest.fn().mockResolvedValue(true);
    const repo = {
      listActiveByTrigger: jest.fn().mockResolvedValue([selfRule]),
      applyWithRun,
      recordRun: jest.fn().mockResolvedValue(true),
    } as unknown as AutomationsRepository;

    const engine = new AutomationEngine(
      repo,
      { exists: jest.fn().mockResolvedValue(true) } as unknown as LabelsRepository,
      {
        resolve: jest.fn().mockResolvedValue({
          roleKey: 'teamlead',
          permissionKeys: ['crm.conversation.reply'],
        }),
      } as unknown as AuthorAuthorityClient,
      fakeStatusRepository(),
    );

    // A REAL dispatcher, with the engine subscribed exactly as app.module wires it.
    const dispatcher = new DomainEventDispatcher();
    const publishSpy = jest.spyOn(dispatcher, 'publish');
    dispatcher.subscribe((e) => engine.handle(e));

    // One publish — as a controller would do after a status write.
    await expect(dispatcher.publish(statusEvent())).resolves.toBe(1);

    // The rule ran once…
    expect(applyWithRun).toHaveBeenCalledTimes(1);
    // …and its own status write produced NO further event: the dispatcher saw exactly one publish.
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('the engine exposes no way to publish (it holds no dispatcher reference)', () => {
    const engine = new AutomationEngine(
      {} as unknown as AutomationsRepository,
      {} as unknown as LabelsRepository,
      {} as unknown as AuthorAuthorityClient,
      fakeStatusRepository(),
    );
    // Nothing on the engine is, or holds, a dispatcher — so it cannot emit even by accident.
    for (const value of Object.values(engine as unknown as Record<string, unknown>)) {
      expect(value instanceof DomainEventDispatcher).toBe(false);
    }
    expect((engine as unknown as Record<string, unknown>).publish).toBeUndefined();
  });

  it('two chained self-satisfying rules still produce exactly two applications, not a chain', async () => {
    const second = { ...selfRule, id: 'r-self-2', position: 1 };
    const applyWithRun = jest.fn().mockResolvedValue(true);
    const engine = new AutomationEngine(
      {
        listActiveByTrigger: jest.fn().mockResolvedValue([selfRule, second]),
        applyWithRun,
        recordRun: jest.fn().mockResolvedValue(true),
      } as unknown as AutomationsRepository,
      { exists: jest.fn().mockResolvedValue(true) } as unknown as LabelsRepository,
      {
        resolve: jest
          .fn()
          .mockResolvedValue({ roleKey: 'teamlead', permissionKeys: ['crm.conversation.reply'] }),
      } as unknown as AuthorAuthorityClient,
      fakeStatusRepository(),
    );
    const dispatcher = new DomainEventDispatcher();
    dispatcher.subscribe((e) => engine.handle(e));
    await expect(dispatcher.publish(statusEvent())).resolves.toBe(2);
    expect(applyWithRun).toHaveBeenCalledTimes(2); // bounded by the rule count, not by a chain
  });
});
