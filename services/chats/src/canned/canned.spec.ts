import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { CannedRepository } from './canned.repository';
import { CannedController } from './canned.grpc.controller';

/**
 * T022 (feature 013, US2) — canned responses: account-scoped, unique per name, and **text only**
 * (FR-009). The last part is proven structurally: the module has no message/conversation surface to
 * reach, so no code path could send anything.
 */

function fakePrisma(over: Record<string, jest.Mock> = {}) {
  const cannedResponse = {
    findMany: over.findMany ?? jest.fn().mockResolvedValue([]),
    create:
      over.create ??
      jest.fn().mockResolvedValue({ id: 'cr1', name: 'greeting', body: 'Thanks for reaching out.' }),
  };
  const message = { create: jest.fn(), findMany: jest.fn() };
  const conversation = { findFirst: jest.fn(), updateMany: jest.fn() };
  const forAccount = jest.fn().mockReturnValue({ cannedResponse, message, conversation });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    cannedResponse,
    message,
    conversation,
    forAccount,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', 'crm.templates.manage');
  return m;
}

const build = (prisma: PrismaService) => new CannedController(new CannedRepository(prisma));

describe('Canned responses', () => {
  it('creates one under the caller account with trimmed fields', async () => {
    const { prisma, cannedResponse, forAccount } = fakePrisma();
    const res = await build(prisma).createCannedResponse(
      { name: '  greeting  ', body: '  Thanks for reaching out.  ' },
      md('acc-1'),
    );
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(cannedResponse.create.mock.calls[0][0]).toMatchObject({
      data: { account_id: 'acc-1', name: 'greeting', body: 'Thanks for reaching out.' },
    });
    expect(res).toEqual({ id: 'cr1', name: 'greeting', body: 'Thanks for reaching out.' });
  });

  it('lists only the caller account library, alphabetically', async () => {
    const { prisma, cannedResponse, forAccount } = fakePrisma({
      findMany: jest.fn().mockResolvedValue([{ id: 'a', name: 'a', body: 'x' }]),
    });
    const res = await build(prisma).listCannedResponses({}, md('acc-5'));
    expect(forAccount).toHaveBeenCalledWith('acc-5');
    expect(cannedResponse.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ name: 'asc' }],
    });
    expect(res.canned).toHaveLength(1);
  });

  it('requires both a name and a body', async () => {
    const { prisma, cannedResponse } = fakePrisma();
    await expect(
      build(prisma).createCannedResponse({ name: '', body: 'text' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      build(prisma).createCannedResponse({ name: 'x', body: '   ' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    expect(cannedResponse.create).not.toHaveBeenCalled();
  });

  it('conflicts on a duplicate name instead of creating a second entry', async () => {
    const { prisma } = fakePrisma({
      create: jest.fn().mockRejectedValue(new Error('unique constraint failed')),
    });
    await expect(
      build(prisma).createCannedResponse({ name: 'dup', body: 'text' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('never sends a message — no message/conversation write happens on any path (FR-009)', async () => {
    const { prisma, message, conversation } = fakePrisma();
    const ctrl = build(prisma);
    await ctrl.createCannedResponse({ name: 'n', body: 'b' }, md());
    await ctrl.listCannedResponses({}, md());
    expect(message.create).not.toHaveBeenCalled();
    expect(conversation.updateMany).not.toHaveBeenCalled();
  });

  it('takes exactly one dependency — the canned repository (no message path reachable)', () => {
    expect(CannedController.length).toBe(1);
  });

  it('is fail-closed without an account context', async () => {
    const { prisma } = fakePrisma();
    const bare = new Metadata();
    bare.set('x-actor-permissions', 'crm.templates.manage');
    await expect(build(prisma).listCannedResponses({}, bare)).rejects.toBeInstanceOf(RpcException);
  });
});
