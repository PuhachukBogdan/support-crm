import { Metadata } from '@grpc/grpc-js';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { AuthAccessGuard } from '../security/permission.guard';
import { REQUIRED_AUTH_PERMISSION_KEY } from '../security/requires-auth-permission.decorator';
import { API_KEYS_PERMISSION, ApiKeysGrpcController } from './api-keys.grpc.controller';

/**
 * ⭐ W31 / feature 038 — **FR-004, server-side.** The key surface is refused at THIS tier to anyone
 * without the administrative key, whatever the screen shows: an API key mints staff accounts
 * (SEC-PV1), so a hidden button proves nothing about a crafted request that skipped the gateway.
 *
 * ── What this file deliberately does NOT assert ──────────────────────────────────────────────────
 * Which ROLES hold `platform.settings.manage` — that is the catalogue's fact, asserted where the
 * catalogue lives. Here the permission set is a parameter, exactly as in `channel-admin.spec.ts`.
 */

const HANDLERS = [
  ['ListApiKeys', ApiKeysGrpcController.prototype.listApiKeys],
  ['IssueApiKey', ApiKeysGrpcController.prototype.issueApiKey],
  ['RotateApiKey', ApiKeysGrpcController.prototype.rotateApiKey],
  ['RevokeApiKey', ApiKeysGrpcController.prototype.revokeApiKey],
] as const;

/** Everything a teamlead holds — every supervisory capability, no tenant configuration. That is
 *  what makes the refusal about THIS key rather than about a caller who could do nothing at all. */
const TEAMLEAD_PERMS = [
  'crm.inbox.view',
  'crm.conversation.reply',
  'crm.conversation.assign',
  'crm.labels.manage',
  'users.list.view',
  'platform.group.manage',
];
const ADMIN_PERMS = [...TEAMLEAD_PERMS, API_KEYS_PERMISSION];

function ctx(handler: unknown, permissions: string[]) {
  const md = new Metadata();
  md.set('x-actor-account-id', 'acct-A');
  md.set('x-actor-user-id', 'u-admin');
  if (permissions.length > 0) md.set('x-actor-permissions', permissions.join(','));
  return {
    getType: () => 'rpc',
    getHandler: () => handler,
    getClass: () => ApiKeysGrpcController,
    switchToRpc: () => ({ getContext: () => md }),
  } as never;
}

describe('*** every API-key rpc is gated by `platform.settings.manage` (server-side) ***', () => {
  it.each(HANDLERS)('%s declares the permission', (_name, handler) => {
    expect(new Reflector().get<string>(REQUIRED_AUTH_PERMISSION_KEY, handler)).toBe(
      'platform.settings.manage',
    );
  });

  it.each(HANDLERS)('%s is refused for a teamlead-shaped permission set', (_name, handler) => {
    const guard = new AuthAccessGuard(new Reflector());
    expect(() => guard.canActivate(ctx(handler, TEAMLEAD_PERMS))).toThrow(RpcException);
  });

  it.each(HANDLERS)('%s is refused when NO permission context arrives at all', (_name, handler) => {
    // The shape of feature 016's live defect: a route carrying no metadata makes the gateway forward
    // an empty value, and the owning service must then refuse rather than assume goodwill.
    const guard = new AuthAccessGuard(new Reflector());
    expect(() => guard.canActivate(ctx(handler, []))).toThrow(RpcException);
  });

  it.each(HANDLERS)('⭐ POSITIVE CONTROL: %s is admitted with the configuration key', (_name, handler) => {
    const guard = new AuthAccessGuard(new Reflector());
    expect(guard.canActivate(ctx(handler, ADMIN_PERMS))).toBe(true);
  });
});
