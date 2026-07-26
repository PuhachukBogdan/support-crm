import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { ChatsAccessGuard } from './permission.guard';

/** Build a fake rpc ExecutionContext carrying the given `x-actor-permissions` metadata. */
function rpcCtx(perms?: string, type: 'rpc' | 'http' = 'rpc'): ExecutionContext {
  const md = {
    get: (k: string) => (k === 'x-actor-permissions' && perms !== undefined ? [perms] : []),
  };
  return {
    getType: () => type,
    switchToRpc: () => ({ getContext: () => md }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

/** Reflector stub that reports the route's required permission (or undefined = not gated). */
const reflector = (required: string | undefined) =>
  ({ getAllAndOverride: () => required }) as unknown as Reflector;

describe('ChatsAccessGuard (service-tier RBAC, SC-004)', () => {
  it('passes when the handler is not permission-gated', () => {
    const guard = new ChatsAccessGuard(reflector(undefined));
    expect(guard.canActivate(rpcCtx('crm.inbox.view'))).toBe(true);
  });

  it('passes when the caller context carries the required permission', () => {
    const guard = new ChatsAccessGuard(reflector('crm.inbox.view'));
    expect(guard.canActivate(rpcCtx('crm.inbox.view,crm.conversation.reply'))).toBe(true);
  });

  it('DENIES (deny-by-default) when the required permission is missing', () => {
    const guard = new ChatsAccessGuard(reflector('crm.conversation.reply'));
    expect(() => guard.canActivate(rpcCtx('crm.inbox.view'))).toThrow(RpcException);
  });

  it('DENIES when no actor-permission context is present (call skipped the gateway)', () => {
    const guard = new ChatsAccessGuard(reflector('crm.inbox.view'));
    expect(() => guard.canActivate(rpcCtx(undefined))).toThrow(RpcException);
  });

  it('is inert outside rpc context', () => {
    const guard = new ChatsAccessGuard(reflector('crm.inbox.view'));
    expect(guard.canActivate(rpcCtx(undefined, 'http'))).toBe(true);
  });
});
