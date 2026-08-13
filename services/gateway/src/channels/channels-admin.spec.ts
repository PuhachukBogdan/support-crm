import { of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import { ChannelsAdminController } from './channels-admin.controller';

/**
 * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the channels admin edge.
 *
 * ⚠️ Constructing with `new` exercises no decorator, so the PERMISSION GATE is asserted by
 * reflection here (the declared key) and by behaviour in `live-w15.sh` (a teamlead's real 403).
 * What behaves in this file is the thin-proxy part: what is forwarded, what is refused before a
 * request exists, and what an empty answer looks like.
 */

function controllerFor(overrides: {
  listChannels?: () => unknown;
  upsertEmailChannel?: (d: unknown, md: Metadata) => unknown;
}) {
  const calls: Array<{ rpc: string; data: unknown; md: Metadata }> = [];
  const service = {
    listChannels: (data: unknown, md: Metadata) => {
      calls.push({ rpc: 'listChannels', data, md });
      return of(overrides.listChannels ? overrides.listChannels() : { channels: [] });
    },
    upsertEmailChannel: (data: unknown, md: Metadata) => {
      calls.push({ rpc: 'upsertEmailChannel', data, md });
      return of(
        overrides.upsertEmailChannel ? overrides.upsertEmailChannel(data, md) : { id: 'ch-1' },
      );
    },
  };
  const client = { getService: () => service } as unknown as ClientGrpc;
  const controller = new ChannelsAdminController(client);
  controller.onModuleInit();
  return { controller, calls };
}

const req = {
  claims: { accountId: 'acc-1', userId: 'u-admin', roles: ['admin'] },
  effective: { permissionKeys: ['platform.settings.manage'] },
} as unknown as Request;

describe('*** both routes declare the tenant-configuration key ***', () => {
  it('GET and PUT are gated by `platform.settings.manage` — not a new key, not a role check', () => {
    const reflector = new Reflector();
    for (const handler of [
      ChannelsAdminController.prototype.list,
      ChannelsAdminController.prototype.upsertEmail,
    ]) {
      expect(reflector.get<string>(REQUIRED_PERMISSION_KEY, handler)).toBe('platform.settings.manage');
    }
  });
});

describe('the list', () => {
  it('answers an omitted repeated field as an EMPTY list — a state, not a crash', async () => {
    const { controller } = controllerFor({ listChannels: () => ({}) });
    await expect(controller.list(req)).resolves.toEqual({ channels: [] });
  });

  it('forwards the caller context as metadata — the service re-checks it (Principle II)', async () => {
    const { controller, calls } = controllerFor({});
    await controller.list(req);
    const md = calls[0]!.md;
    expect(md.get('x-actor-account-id')).toEqual(['acc-1']);
    expect(md.get('x-actor-permissions')).toEqual(['platform.settings.manage']);
  });
});

describe('the upsert', () => {
  it('forwards brandId + the trimmed address and returns the service’s row as-is', async () => {
    const { controller, calls } = controllerFor({
      upsertEmailChannel: (d) => ({ ...(d as object), id: 'ch-9', kind: 'email', enabled: true }),
    });
    const res = await controller.upsertEmail('brand-a', { address: '  support@stand.test ' }, req);
    expect(calls[0]!.data).toEqual({ brandId: 'brand-a', address: 'support@stand.test' });
    expect(res).toMatchObject({ id: 'ch-9', address: 'support@stand.test' });
  });

  it('refuses a missing address BEFORE a request exists', async () => {
    const { controller, calls } = controllerFor({});
    await expect(controller.upsertEmail('brand-a', {}, req)).rejects.toThrow(BadRequestException);
    await expect(controller.upsertEmail('brand-a', { address: '   ' }, req)).rejects.toThrow(
      BadRequestException,
    );
    expect(calls).toHaveLength(0);
  });
});
