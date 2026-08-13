import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { USERS_PROTO } from '@crm/common';
import { Metadata } from '@grpc/grpc-js';
import { MaintenanceController } from './maintenance.controller';
import type { MaintenanceService } from './maintenance.service';
import type { PresenceSweepService } from '../presence/presence-sweep.service';
import type { OperatorRepository } from '../operator/operator.repository';

/**
 * Feature 031 (roadmap 4.20) — **the routing question, asked by a MACHINE.**
 *
 * ── Why this rpc exists at all, in one paragraph ────────────────────────────────────────────────
 * `UsersReadService.ListOperatorsByAuthUsers` already answers it, gated on `crm.conversation.assign`,
 * and its own comment states the rule: *"the caller forwards its own credentials unchanged; calling as a
 * system actor would launder the permission."* The backlog drain has no credentials to forward — a
 * periodic tick belongs to no person — so relaxing that rpc would have made its own sentence false for
 * every caller. The machine gets a second surface instead, gated on the actor KIND, which no breadth of
 * permission satisfies.
 *
 * ⚠️ Discovered live, not in design: the drain's first version called the human rpc with the worker's
 * metadata and was refused on every tick. The queue simply never drained, and a queue that never drains
 * looks exactly like a queue with nothing in it.
 */

function build(
  rows: { operatorId: string; authUserId: string; state: string; blockedChannels: string[] }[],
) {
  const resolveByAuthUserIds = jest.fn(async () => rows);
  const ctrl = new MaintenanceController(
    {} as unknown as MaintenanceService,
    {} as unknown as PresenceSweepService,
    { resolveByAuthUserIds } as unknown as OperatorRepository,
    // Feature 033: the participant registration lives on the same controller for the same three
    // properties. Unused by this rpc, and deliberately a stub that would THROW if reached — a routing
    // test that quietly touched the envelope path would be testing two things and proving neither.
    {
      register: () => {
        throw new Error('the routing rpc must not touch the participant path');
      },
    } as unknown as import('../channel/channel-participant.service').ChannelParticipantService,
    {} as never,
    {} as never,
  );
  return { ctrl, resolveByAuthUserIds };
}

const system = () => {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  return md;
};

const ROW = {
  operatorId: 'op-1',
  authUserId: 'u-1',
  state: 'online',
  blockedChannels: [] as string[],
};

describe('ResolveRoutingOperators — the machine surface', () => {
  it('answers a system caller with the same staffing facts the human rpc returns', async () => {
    const { ctrl } = build([ROW]);
    const res = await ctrl.resolveRoutingOperators(
      { accountId: 'acc-1', authUserIds: ['u-1'] },
      system(),
    );
    expect(res).toEqual({
      operators: [{ operatorId: 'op-1', authUserId: 'u-1', state: 1, blockedChannels: [] }],
    });
  });

  it('⛔ refuses a USER session, however broad its permissions', async () => {
    // The gate is the actor KIND. A session holding `crm.conversation.assign` already has the human rpc;
    // reaching this one would be a second, unpermissioned way to name an account.
    const { ctrl } = build([ROW]);
    const user = new Metadata();
    user.set('x-actor-user-id', 'u-9');
    user.set('x-actor-account-id', 'acc-1');
    user.set('x-actor-permissions', 'crm.conversation.assign,platform.audit.view');
    await expect(
      ctrl.resolveRoutingOperators({ accountId: 'acc-1', authUserIds: ['u-1'] }, user),
    ).rejects.toBeDefined();
  });

  it('⛔ refuses an ABSENT account rather than defaulting to one', async () => {
    // A machine has no account of its own, so the account is data. Defaulting it — to the first account,
    // to the seed, to anything — is a cross-account read waiting to happen.
    const { ctrl, resolveByAuthUserIds } = build([ROW]);
    await expect(
      ctrl.resolveRoutingOperators({ authUserIds: ['u-1'] }, system()),
    ).rejects.toBeDefined();
    await expect(
      ctrl.resolveRoutingOperators({ accountId: '   ', authUserIds: ['u-1'] }, system()),
    ).rejects.toBeDefined();
    expect(resolveByAuthUserIds).not.toHaveBeenCalled();
  });

  it('⭐ reads through the SAME repository method as the human rpc, under the named account', async () => {
    // One method answers "who can take this work?" completely — the active filter and the presence state
    // side by side. Two implementations would be two places to forget one of them.
    const { ctrl, resolveByAuthUserIds } = build([ROW]);
    await ctrl.resolveRoutingOperators(
      { accountId: 'acc-42', authUserIds: ['u-1', 'u-2'] },
      system(),
    );
    expect(resolveByAuthUserIds).toHaveBeenCalledWith('acc-42', ['u-1', 'u-2']);
  });

  it('⚠️ an unknown presence state encodes as OFFLINE, never as available', async () => {
    const { ctrl } = build([{ ...ROW, state: 'not-a-state' }]);
    const res = (await ctrl.resolveRoutingOperators(
      { accountId: 'acc-1', authUserIds: ['u-1'] },
      system(),
    )) as { operators: { state: number }[] };
    expect(res.operators[0]!.state).toBe(4);
  });

  it('the rpc is declared on the MAINTENANCE service, not on the read service', () => {
    const proto = readFileSync(USERS_PROTO, 'utf8');
    const maintenance =
      /service\s+UsersMaintenanceService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const read = /service\s+UsersReadService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    expect(maintenance).toMatch(/rpc\s+ResolveRoutingOperators\s*\(/);
    expect(read).not.toMatch(/ResolveRoutingOperators/);
  });
});
