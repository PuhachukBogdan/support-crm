import { AutomationEngine } from './engine';
import type { AutomationsRepository, AutomationRow } from './automations.repository';
import type { LabelsRepository } from '../labels/labels.repository';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { DomainEvent, ConversationFacts } from '../events/events.types';

/**
 * US4 (feature 024, roadmap 5.3 — ADR 0039 §5.2) — an automation rule bound to a GROUP.
 *
 * ⚠️ **The assertion that matters is the DANGLING one.** A rule scoped to a desk that no longer
 * exists must match NOTHING. The failure mode of the obvious alternative is the dangerous one: a rule
 * that quietly becomes an everything rule, firing on work it was never meant to see, and invisible
 * until it has already acted.
 *
 * That property here is structural rather than checked. Chats cannot see auth's tables, so there is
 * no "does this group still exist?" lookup — and none is needed, because a deleted group is never
 * again the routed group of anything. The comparison simply stops matching. There is no branch that
 * could be written the wrong way round.
 */

const facts = (over: Partial<ConversationFacts> = {}): ConversationFacts => ({
  status: 'open',
  priority: null,
  brandId: 'brand-a',
  channel: 'chat',
  hasAssignee: false,
  labelIds: [],
  routedGroupId: null,
  ...over,
});

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  trigger: 'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
  accountId: 'acc-1',
  conversationId: 'c1',
  eventKey: 'conv:c1',
  facts: facts(),
  ...over,
});

const rule = (over: Partial<AutomationRow> = {}): AutomationRow => ({
  id: 'r1',
  name: 'set priority',
  active: true,
  position: 0,
  revision: 1,
  author_user_id: 'author-1',
  scope_group_id: null,
  definition: {
    trigger: 'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
    conditions: [],
    actions: [{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }],
  },
  created_at: new Date('2026-08-05T10:00:00.000Z'),
  updated_at: new Date('2026-08-05T10:00:00.000Z'),
  ...over,
});

function build(rules: AutomationRow[], perms: string[] = ['crm.conversation.reply']) {
  const recordRun = jest.fn(async () => true);
  const applyWithRun = jest.fn(async () => true);
  const automations = {
    listActiveByTrigger: jest.fn(async () => rules),
    recordRun,
    applyWithRun,
    labelIdsFor: jest.fn(async () => []),
  } as unknown as AutomationsRepository;
  const labels = { exists: jest.fn(async () => true) } as unknown as LabelsRepository;
  const authority = {
    resolve: jest.fn(async () => ({ roleKey: 'teamlead', permissionKeys: perms })),
  } as unknown as AuthorAuthorityClient;
  const engine = new AutomationEngine(automations, labels, authority);
  return { engine, applyWithRun, recordRun };
}

describe('an automation rule scoped to a group', () => {
  it('fires for work routed to ITS group', async () => {
    const { engine, applyWithRun } = build([rule({ scope_group_id: 'g-payments' })]);
    const applied = await engine.handle(event({ facts: facts({ routedGroupId: 'g-payments' }) }));
    expect(applied).toBe(1);
    expect(applyWithRun).toHaveBeenCalled();
  });

  it('does NOT fire for another desk’s work', async () => {
    const { engine, applyWithRun, recordRun } = build([rule({ scope_group_id: 'g-payments' })]);
    const applied = await engine.handle(event({ facts: facts({ routedGroupId: 'g-vip' }) }));
    expect(applied).toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
    // Recorded, so "why did nothing happen?" stays answerable — the same discipline as a condition
    // that did not match.
    expect(recordRun).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({ outcome: 'not_matched' }),
    );
  });

  it('does NOT fire for work routed to NO desk', async () => {
    const { engine, applyWithRun } = build([rule({ scope_group_id: 'g-payments' })]);
    expect(await engine.handle(event({ facts: facts({ routedGroupId: null }) }))).toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
  });

  it('⚠️ a rule whose group is GONE matches nothing — it does not become an everything rule', async () => {
    // The group was deleted. Nothing is routed to it any more, so nothing matches — with no lookup,
    // no cross-service call, and no branch that could have been written the wrong way round.
    const { engine, applyWithRun } = build([rule({ scope_group_id: 'g-deleted' })]);
    for (const routedGroupId of [null, 'g-payments', 'g-vip']) {
      expect(await engine.handle(event({ facts: facts({ routedGroupId }) }))).toBe(0);
    }
    expect(applyWithRun).not.toHaveBeenCalled();
  });

  it('an UNSCOPED rule is unaffected — every existing rule keeps behaving exactly as before', async () => {
    const { engine } = build([rule({ scope_group_id: null })]);
    expect(await engine.handle(event({ facts: facts({ routedGroupId: null }) }))).toBe(1);
    expect(await engine.handle(event({ facts: facts({ routedGroupId: 'g-anything' }) }))).toBe(1);
  });

  it('a scoped rule and an unscoped rule both see their own work in one pass', async () => {
    const { engine } = build([
      rule({ id: 'r-scoped', name: 'scoped', scope_group_id: 'g-payments' }),
      rule({ id: 'r-open', name: 'open', scope_group_id: null }),
    ]);
    expect(await engine.handle(event({ facts: facts({ routedGroupId: 'g-vip' }) }))).toBe(1);
    expect(await engine.handle(event({ facts: facts({ routedGroupId: 'g-payments' }) }))).toBe(2);
  });

  it('a group scope grants the rule NO capability its author lacks', async () => {
    // FR-026. Scoping narrows what a rule SEES; it never widens what a rule may DO. The author's
    // authority is still resolved live and still checked per action — the scope runs first and
    // changes nothing about that.
    const scoped = rule({ scope_group_id: 'g-payments' });
    const withPerm = build([scoped], ['crm.conversation.reply']);
    const withoutPerm = build([scoped], []);
    const e = event({ facts: facts({ routedGroupId: 'g-payments' }) });

    expect(await withPerm.engine.handle(e)).toBe(1);
    expect(await withoutPerm.engine.handle(e)).toBe(0);
    expect(withoutPerm.applyWithRun).not.toHaveBeenCalled();
  });
});
