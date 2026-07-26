import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { AutomationsRepository } from './automations.repository';
import { AutomationsController } from './automations.grpc.controller';

function md(perms: string[], accountId = 'acc-1', userId = 'u1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

/**
 * T033 (feature 015) — deleting an automation rule is a sensitive act, so the delete and its audit entry
 * commit in ONE transaction (spec Q3 / FR-009).
 *
 * The assertion that matters most is the negative one: an absent id must write **no** entry. `deleteMany`
 * reports a count of 0 for an id that is not there while the transaction still commits, so a blind
 * delete-and-record would file an entry for a deletion that never happened. A trail that records non-events
 * is worse than one with a gap — a reader cannot tell them apart.
 */
describe('DeleteAutomation is audited (feature 015)', () => {
  const RULE = {
    id: 'a1',
    name: 'trackb-rule',
    active: true,
    position: 0,
    revision: 4,
    author_user_id: 'author-1',
    definition: {
      trigger: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
      conditions: [],
      actions: [{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }],
    },
    created_at: new Date('2026-07-27T10:00:00Z'),
    updated_at: new Date('2026-07-27T10:00:00Z'),
  };

  function build(existing: unknown) {
    const auditCreate = jest.fn((a: unknown) => ({ __audit: a }));
    const deleteMany = jest.fn(() => ({ __delete: true }));
    const $transaction = jest.fn(async (batch: unknown) => {
      void batch;
      return [{ count: existing ? 1 : 0 }];
    });
    const scoped = {
      automation: { findFirst: jest.fn(async () => existing), deleteMany },
      auditEntry: { create: auditCreate },
      $transaction,
    };
    const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
    const ctrl = new AutomationsController(
      new AutomationsRepository(prisma),
      new AuditRepository(prisma),
    );
    return { ctrl, auditCreate, $transaction };
  }

  it('writes the entry in the SAME transaction as the delete', async () => {
    const { ctrl, auditCreate, $transaction } = build(RULE);
    await ctrl.deleteAutomation({ id: 'a1' }, md(['crm.automations.manage']));

    expect($transaction).toHaveBeenCalledTimes(1);
    const batch = $transaction.mock.calls[0]![0] as unknown as unknown[];
    expect(batch).toHaveLength(2); // the delete + the entry — neither can land without the other

    const data = (auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      action: 'automation.delete',
      actor_user_id: 'u1',
      target_ref: 'a1',
      detail_json: { name: 'trackb-rule', revision: 4 },
    });
  });

  it('*** writes NO entry for an id that is not in this account ***', async () => {
    const { ctrl, auditCreate, $transaction } = build(null);
    await expect(
      ctrl.deleteAutomation({ id: 'nope' }, md(['crm.automations.manage'])),
    ).rejects.toBeInstanceOf(RpcException);
    expect(auditCreate).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it('records the rule NAME, which is operator-authored — never customer data', async () => {
    const { ctrl, auditCreate } = build(RULE);
    await ctrl.deleteAutomation({ id: 'a1' }, md(['crm.automations.manage']));
    const data = (auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    // The detail allow-list (libs/common/audit/detail.ts) permits only `name` and `revision` here, so a
    // conversation body or a player id is not expressible even if someone tried.
    expect(Object.keys(data.detail_json as object).sort()).toEqual(['name', 'revision']);
  });

  it('marks an action performed under owner view-as with the REAL actor', async () => {
    const { ctrl, auditCreate } = build(RULE);
    const m = md(['crm.automations.manage']);
    m.set('x-is-preview', 'true');
    await ctrl.deleteAutomation({ id: 'a1' }, m);
    const data = (auditCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data.actor_user_id).toBe('u1');
    expect(data.under_preview).toBe(true);
  });
});
