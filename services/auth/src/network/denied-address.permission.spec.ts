import { Metadata } from '@grpc/grpc-js';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { AuthAccessGuard } from '../security/permission.guard';
import { REQUIRED_AUTH_PERMISSION_KEY } from '../security/requires-auth-permission.decorator';
import {
  DENIED_ADDRESS_PERMISSION,
  DeniedAddressEdgeController,
  DeniedAddressGrpcController,
} from './denied-address.grpc.controller';

/**
 * ⭐ W32 / feature 039 — **server-side RBAC.** The deny-list is refused at THIS tier to anyone without
 * the administrative key, whatever the screen shows: this list decides who can reach the product at
 * all, so a hidden button proves nothing about a crafted request that skipped the gateway
 * (Principle II).
 *
 * ── What this file deliberately does NOT assert ──────────────────────────────────────────────────
 * Which ROLES hold `platform.settings.manage` — the catalogue's fact, asserted where the catalogue
 * lives. Here the permission set is a parameter, exactly as in `api-keys.permission.spec.ts`.
 */

const HANDLERS = [
  ['ListDeniedAddresses', DeniedAddressGrpcController.prototype.listDeniedAddresses],
  ['AddDeniedAddress', DeniedAddressGrpcController.prototype.addDeniedAddress],
  ['RemoveDeniedAddress', DeniedAddressGrpcController.prototype.removeDeniedAddress],
] as const;

/** Everything a teamlead holds — every supervisory capability, no tenant configuration. */
const TEAMLEAD_PERMS = [
  'crm.inbox.view',
  'crm.conversation.reply',
  'crm.conversation.assign',
  'crm.labels.manage',
  'users.list.view',
  'platform.group.manage',
];
const ADMIN_PERMS = [...TEAMLEAD_PERMS, DENIED_ADDRESS_PERMISSION];

function ctx(handler: unknown, permissions: string[]) {
  const md = new Metadata();
  md.set('x-actor-account-id', 'acct-A');
  md.set('x-actor-user-id', 'u-admin');
  if (permissions.length > 0) md.set('x-actor-permissions', permissions.join(','));
  return {
    getType: () => 'rpc',
    getHandler: () => handler,
    getClass: () => DeniedAddressGrpcController,
    switchToRpc: () => ({ getContext: () => md }),
  } as never;
}

describe('*** every deny-list rpc is gated by `platform.settings.manage` (server-side) ***', () => {
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

/**
 * ⭐ The edge rpc is gated by the actor KIND, which no breadth of permission satisfies — and it is a
 * separate controller precisely so that no class-level permission decorator can be mistaken for its
 * gate (see the class banner).
 */
describe('*** the edge union is a MACHINE surface — actor kind, never a permission ***', () => {
  const edge = () => new DeniedAddressEdgeController({ listForEdge: async () => [] } as never);

  it('declares NO permission — a permission would be the wrong question here', () => {
    expect(
      new Reflector().get<string>(
        REQUIRED_AUTH_PERMISSION_KEY,
        DeniedAddressEdgeController.prototype.listDeniedAddressesForEdge,
      ),
    ).toBeUndefined();
  });

  it('⭐ refuses a human caller holding EVERY administrative permission', async () => {
    const md = new Metadata();
    md.set('x-actor-account-id', 'acct-A');
    md.set('x-actor-user-id', 'u-admin');
    md.set('x-actor-permissions', ADMIN_PERMS.join(','));
    await expect(edge().listDeniedAddressesForEdge({}, md)).rejects.toThrow(RpcException);
  });

  it('refuses a caller with no metadata at all', async () => {
    await expect(edge().listDeniedAddressesForEdge({}, new Metadata())).rejects.toThrow(
      RpcException,
    );
  });

  it('POSITIVE CONTROL: a system actor is admitted', async () => {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    await expect(edge().listDeniedAddressesForEdge({}, md)).resolves.toEqual({ addresses: [] });
  });
});
