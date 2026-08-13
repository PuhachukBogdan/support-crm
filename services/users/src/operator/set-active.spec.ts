import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { USERS_PROTO } from '@crm/common';
import { Metadata } from '@grpc/grpc-js';
import { MaintenanceController } from '../maintenance/maintenance.controller';
import type { MaintenanceService } from '../maintenance/maintenance.service';
import type { PresenceSweepService } from '../presence/presence-sweep.service';
import { OperatorRepository } from './operator.repository';
import { StaffLifecycleRepository } from '../maintenance/staff-lifecycle.repository';
import type { PrismaService } from '../prisma.service';
import type { ChannelParticipantService } from '../channel/channel-participant.service';

/**
 * T031 (W31 / feature 038 — ADR 0043 §3): **the writer of `Operator.active`.**
 *
 * The flag has been READ since feature 018 — the assignable list, the routing pool and the participant
 * resolver all honour it — and until now nothing in the product wrote it. Deactivation existed as a
 * column and as nobody's capability, which is the half of SEC-PV2 that never existed at all.
 *
 * ⚠️ **An unknown identity is a REFUSAL here, not a quiet `changed: false`** — and the choice is
 * recorded rather than inherited. The neighbours split two ways: the routing read answers with
 * absence (a candidate that cannot be resolved is simply not a candidate), while `GetChannelEnvelope`
 * answers NOT_FOUND. This is a WRITE that closes somebody's account, so it follows the second: a
 * mistyped id or the wrong account in the metadata would otherwise report a successful offboarding
 * while the person keeps taking work — the exact failure that looks like nothing.
 */

function fakePrisma(row: { id: string; active: boolean } | null, updated = 1) {
  const operator = {
    findFirst: jest.fn().mockResolvedValue(row),
    updateMany: jest.fn().mockResolvedValue({ count: updated }),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const operatorPresence = { findMany: jest.fn().mockResolvedValue([]) };
  const operatorChannelBlock = { findMany: jest.fn().mockResolvedValue([]) };
  const forAccount = jest.fn().mockReturnValue({ operator, operatorPresence, operatorChannelBlock });
  return { prisma: { forAccount } as unknown as PrismaService, operator, forAccount };
}

function build(prisma: PrismaService) {
  return new MaintenanceController(
    {} as unknown as MaintenanceService,
    {} as unknown as PresenceSweepService,
    new OperatorRepository(prisma),
    // Deliberately a stub that would THROW if reached: a lifecycle test that quietly touched the
    // envelope path would be testing two things and proving neither.
    {
      register: () => {
        throw new Error('the operator lifecycle rpc must not touch the participant path');
      },
    } as unknown as ChannelParticipantService,
    // ⭐ W31: the WRITER. It is its own class rather than a method on the read repository above,
    // because `tests/users-read/no-outbound.spec.ts` pins those two repositories write-free — the
    // guard is right, and the lifecycle flag belongs beside the other system-actor writes.
    new StaffLifecycleRepository(prisma),
  );
}

const system = (accountId = 'acc-1') => {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  if (accountId) md.set('x-actor-account-id', accountId);
  return md;
};

describe('SetOperatorActive — the operator half of deactivation', () => {
  it('writes the flag and reports that it changed', async () => {
    const { prisma, operator, forAccount } = fakePrisma({ id: 'op-1', active: true });

    const res = await build(prisma).setOperatorActive({ authUserId: 'u-1', active: false }, system());

    expect(res).toEqual({ changed: true, operatorId: 'op-1' });
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(operator.updateMany).toHaveBeenCalledWith({
      // The old value is in the predicate, so two racing calls cannot both claim the change.
      where: { id: 'op-1', active: true },
      data: { active: false },
    });
  });

  it('⭐ a REPEATED offboarding is a no-op success — changed: false, nothing written', async () => {
    // ADR 0043 §3: a repeated termination event is not an error. The caller must still be able to tell
    // «done» from «was already so», which is the whole reason the flag is on the wire.
    const { prisma, operator } = fakePrisma({ id: 'op-1', active: false });

    const res = await build(prisma).setOperatorActive({ authUserId: 'u-1', active: false }, system());

    expect(res).toEqual({ changed: false, operatorId: 'op-1' });
    expect(operator.updateMany).not.toHaveBeenCalled();
  });

  it('reactivates through the SAME rpc — one writer, two directions', async () => {
    const { prisma, operator } = fakePrisma({ id: 'op-1', active: false });
    const res = await build(prisma).setOperatorActive({ authUserId: 'u-1', active: true }, system());
    expect(res).toEqual({ changed: true, operatorId: 'op-1' });
    expect(operator.updateMany.mock.calls[0]![0]).toMatchObject({ data: { active: true } });
  });

  it('⛔ an unknown identity is REFUSED, never reported as a successful no-op', async () => {
    // See the file header: a quiet `changed: false` would make «this person has no profile» look
    // identical to «they were already inactive», and an offboarding that reports success while the
    // person keeps taking work is SEC-PV2 itself.
    const { prisma, operator } = fakePrisma(null);
    await expect(
      build(prisma).setOperatorActive({ authUserId: 'nobody', active: false }, system()),
    ).rejects.toBeDefined();
    expect(operator.updateMany).not.toHaveBeenCalled();
  });

  it('⛔ another account\'s operator answers exactly as an unknown one does (isolation)', async () => {
    // `findFirst` under `forAccount` composes the account predicate into the query, so «not yours» and
    // «does not exist» are the SAME query result — there is no comparison here to split into two
    // different answers.
    const { prisma, forAccount } = fakePrisma(null);
    await expect(
      build(prisma).setOperatorActive({ authUserId: 'u-1', active: false }, system('acc-42')),
    ).rejects.toBeDefined();
    expect(forAccount).toHaveBeenCalledWith('acc-42');
  });

  it('⛔ a USER session cannot switch a colleague off, however broad its permissions', async () => {
    // The gate is the actor KIND, which no breadth of permission satisfies — feature 025's argument
    // for lowering somebody's presence, applied to something with teeth.
    const { prisma, operator } = fakePrisma({ id: 'op-1', active: true });
    const user = new Metadata();
    user.set('x-actor-user-id', 'u-9');
    user.set('x-actor-account-id', 'acc-1');
    user.set('x-actor-permissions', 'users.presence.manage,platform.settings.manage');
    await expect(
      build(prisma).setOperatorActive({ authUserId: 'u-1', active: false }, user),
    ).rejects.toBeDefined();
    expect(operator.findFirst).not.toHaveBeenCalled();
  });

  it('⛔ refuses an absent account context rather than defaulting to one', async () => {
    const { prisma, forAccount } = fakePrisma({ id: 'op-1', active: true });
    await expect(
      build(prisma).setOperatorActive({ authUserId: 'u-1', active: false }, system('')),
    ).rejects.toBeDefined();
    await expect(
      build(prisma).setOperatorActive({ authUserId: '', active: false }, system()),
    ).rejects.toBeDefined();
    expect(forAccount).not.toHaveBeenCalled();
  });

  it('⭐ POSITIVE CONTROL: the flag this writes is the one the routing pool reads', async () => {
    // Without this the write is a column nobody consults — which is exactly the state the product was
    // in before this block. The pool read filters on `active: true`, so a deactivated operator stops
    // being a candidate as a consequence of the write above.
    const { prisma, operator } = fakePrisma({ id: 'op-1', active: true });
    await new OperatorRepository(prisma).resolveByAuthUserIds('acc-1', ['u-1']);
    expect(operator.findMany.mock.calls[0]![0]).toMatchObject({ where: { active: true } });
  });

  it('the rpc is declared on the MAINTENANCE service, not on a session-facing one', () => {
    const proto = readFileSync(USERS_PROTO, 'utf8');
    const maintenance = /service\s+UsersMaintenanceService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const profile = /service\s+OperatorProfileService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    expect(maintenance).toMatch(/rpc\s+SetOperatorActive\s*\(/);
    expect(profile).not.toMatch(/SetOperatorActive/);
  });
});
