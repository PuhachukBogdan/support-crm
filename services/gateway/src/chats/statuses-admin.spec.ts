import { of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import { StatusesAdminController } from './statuses-admin.controller';

/**
 * ⭐ W15a (subpoint 3.14) — the status authoring edge. As with the channels edge: the permission
 * gate is asserted by reflection (a `new`-built controller exercises no decorator) and by behaviour
 * in `live-w15a.sh`; what behaves here is the thin-proxy translation — above all the `setActive`
 * marker, which is the one piece of shape the edge itself adds.
 */

function controllerFor() {
  const calls: Array<{ rpc: string; data: Record<string, unknown>; md: Metadata }> = [];
  const service = {
    createConversationStatus: (data: Record<string, unknown>, md: Metadata) => {
      calls.push({ rpc: 'create', data, md });
      return of({ key: 'k', ...data });
    },
    updateConversationStatus: (data: Record<string, unknown>, md: Metadata) => {
      calls.push({ rpc: 'update', data, md });
      return of({ key: data.key, active: data.setActive ? data.active : true });
    },
  };
  const client = { getService: () => service } as unknown as ClientGrpc;
  const controller = new StatusesAdminController(client);
  controller.onModuleInit();
  return { controller, calls };
}

const req = {
  claims: { accountId: 'acc-1', userId: 'u-admin', roles: ['admin'] },
  effective: { permissionKeys: ['platform.settings.manage'] },
} as unknown as Request;

describe('*** both routes declare the tenant-configuration key ***', () => {
  it('POST and PATCH are gated by `platform.settings.manage`', () => {
    const reflector = new Reflector();
    for (const handler of [StatusesAdminController.prototype.create, StatusesAdminController.prototype.update]) {
      expect(reflector.get<string>(REQUIRED_PERMISSION_KEY, handler)).toBe('platform.settings.manage');
    }
  });
});

describe('create', () => {
  it('forwards the three fields trimmed, with the caller context as metadata', async () => {
    const { controller, calls } = controllerFor();
    await controller.create({ category: ' pending ', agentName: ' Waiting ', endUserName: ' In review ' }, req);
    expect(calls[0]!.data).toEqual({ category: 'pending', agentName: 'Waiting', endUserName: 'In review' });
    expect(calls[0]!.md.get('x-actor-permissions')).toEqual(['platform.settings.manage']);
  });

  it('refuses an incomplete body BEFORE a request exists', async () => {
    const { controller, calls } = controllerFor();
    await expect(controller.create({ category: 'open', agentName: 'X' }, req)).rejects.toThrow(BadRequestException);
    expect(calls).toHaveLength(0);
  });
});

describe('update — the setActive marker is the edge’s one piece of shape', () => {
  it('a body WITHOUT `active` sends setActive:false — “unchanged”, not “retire”', async () => {
    const { controller, calls } = controllerFor();
    await controller.update('st_parked', { agentName: 'Parked' }, req);
    expect(calls[0]!.data).toMatchObject({ key: 'st_parked', agentName: 'Parked', setActive: false });
  });

  it('`active: false` travels as an explicit retire; `active: true` as a restore', async () => {
    const { controller, calls } = controllerFor();
    await controller.update('st_parked', { active: false }, req);
    expect(calls[0]!.data).toMatchObject({ setActive: true, active: false });
    await controller.update('st_parked', { active: true }, req);
    expect(calls[1]!.data).toMatchObject({ setActive: true, active: true });
  });
});
