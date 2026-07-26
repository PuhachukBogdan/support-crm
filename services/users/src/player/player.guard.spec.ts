import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { PlayerAccessGuard } from './player.guard';
import { REQUIRED_PLAYER_PERMISSION_KEY } from './requires-player-permission.decorator';

/**
 * US1 (feature 011, T019). The service-tier guard refuses a player read whose gRPC metadata
 * carries no valid caller-permission context — proving a request that bypasses the gateway is
 * still blocked at the owning service (SC-001). It passes only when the required permission is
 * present in the metadata.
 */
function fakeMetadata(perms?: string): Metadata {
  return {
    get: (k: string) => (k === 'x-actor-permissions' && perms !== undefined ? [perms] : []),
  } as unknown as Metadata;
}

/** Build a guard + context sharing ONE reflector (so the metadata spy is the one the guard reads). */
function setup(required: string | undefined, md: Metadata) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: unknown) =>
      key === REQUIRED_PLAYER_PERMISSION_KEY ? required : undefined,
    );
  const guard = new PlayerAccessGuard(reflector);
  const ctx = {
    getType: () => 'rpc',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToRpc: () => ({ getContext: () => md }),
  } as unknown as ExecutionContext;
  return { guard, ctx };
}

describe('PlayerAccessGuard', () => {
  it('refuses a call with NO caller-permission metadata (bypass-gateway blocked)', () => {
    const { guard, ctx } = setup('contact.read', fakeMetadata(undefined));
    expect(() => guard.canActivate(ctx)).toThrow(RpcException);
  });

  it('refuses when the metadata perms LACK the required permission', () => {
    const { guard, ctx } = setup('contact.read', fakeMetadata('tickets.view'));
    expect(() => guard.canActivate(ctx)).toThrow(RpcException);
  });

  it('passes when the required permission is present in the metadata', () => {
    const { guard, ctx } = setup('contact.read', fakeMetadata('tickets.view,contact.read'));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes a handler that is not permission-gated', () => {
    const { guard, ctx } = setup(undefined, fakeMetadata(undefined));
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
