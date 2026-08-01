import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USERS_PACKAGE, USERS_PROTO } from '@crm/common';
import { AppModule } from '../app.module';
import { MaintenanceModule } from './maintenance.module';
import { MaintenanceController } from './maintenance.controller';
// Feature 021 (roadmap 5.6): the operator UI-preference surface — a NEW gRPC service in an EXISTING
// package, which is the case most likely to be assumed rather than checked.
import { UiPreferencesModule } from '../preferences/ui-preferences.module';
import { UiPreferencesController } from '../preferences/ui-preferences.grpc.controller';
// Feature 025 (roadmap 5.9): presence — a THIRD controller on UsersReadService plus a new service.
import { PresenceModule } from '../presence/presence.module';

const ROOT = resolve(__dirname, '..', '..', '..', '..');

/**
 * T050 (feature 017, US3) — **the RPC is actually SERVED** (research R8).
 *
 * This test exists because of a specific live-only defect. Feature 015's single Track-B failure was
 * `users` hosting only the health and ping packages: the service was up, healthy and answering, and the
 * federated audit read failed against it because the handler's package was never registered. Nothing in
 * Track A could see it — a controller compiles and its unit tests pass whether or not anyone hosts it.
 *
 * `UsersMaintenanceService` is a NEW gRPC service in an EXISTING package, which is the case most likely
 * to be assumed rather than checked. So both halves are asserted here:
 *
 *   1. the proto's package is the one `main.ts` hosts (no new entry needed — and that is verified, not
 *      reasoned about);
 *   2. the handler's controller is in the module graph, read from Nest's own metadata rather than from
 *      source text, so a controller that is present but unregistered fails this.
 */
describe('*** UsersMaintenanceService is hosted, not merely written ***', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');

  it('the service is declared in the proto the users server loads', () => {
    expect(proto).toMatch(/service\s+UsersMaintenanceService\s*\{/);
    expect(proto).toMatch(/rpc\s+PurgeExpiredArtefacts\s*\(/);
  });

  it('its package is the one already hosted — so no new package entry is needed', () => {
    const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(proto)?.[1];
    expect(declared).toBe(USERS_PACKAGE);
  });

  it('the controller is registered in the maintenance module', () => {
    const controllers = Reflect.getMetadata('controllers', MaintenanceModule) as unknown[];
    expect(controllers).toContain(MaintenanceController);
  });

  it('the maintenance module is imported by the app module', () => {
    // The link that was missing in 015: a module nobody imports contributes no handlers, and the service
    // answers UNIMPLEMENTED while looking perfectly healthy.
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(MaintenanceModule);
  });

  it('the maintenance module does NOT provide its own object store', () => {
    // Storage credentials stay wired in exactly one module. A maintenance module constructing its own
    // `S3ObjectStore` would be a second credential holder — the thing `single-ingest-path.spec.ts` exists
    // to prevent, arriving through a module definition rather than an import.
    const providers = (Reflect.getMetadata('providers', MaintenanceModule) ?? []) as unknown[];
    expect(JSON.stringify(providers.map((p) => (p as { name?: string })?.name ?? p))).not.toContain(
      'OBJECT_STORE',
    );
  });

  it('no gateway route reaches the maintenance RPC', () => {
    // Asserted structurally in `tests/exports/no-presign.spec.ts` across the whole gateway; repeated here
    // as the local statement of intent, because "system actor only" is worthless if HTTP can ask.
    expect(proto).not.toMatch(/rpc\s+(Delete|Update|Presign|Sign)Upload/);
  });
});

/**
 * T030 (feature 018) — **`UsersReadService` is now implemented across TWO controllers, and all four
 * methods must actually answer.**
 *
 * Nest merges handlers from several controllers into one gRPC service. That is an assumption, not a
 * guarantee, and the failure mode is silent: a handler map that drops one method leaves a service that is
 * up, healthy and answering UNIMPLEMENTED for exactly one call. Feature 015's single live-only defect was
 * that shape one level up (a hosted package whose handler was never wired), and feature 018's own analysis
 * pass found its mirror image (a wired handler with no caller).
 */
describe('*** UsersReadService is served across three controllers, completely ***', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');

  it('the contract declares exactly eight methods on it', () => {
    const block = /service\s+UsersReadService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const rpcs = [...block.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    expect(rpcs.sort()).toEqual([
      'GetOperator',
      // Feature 025 (roadmap 5.9): who is at their desk right now. READ-shaped by necessity — the
      // sibling guard in tests/users-read/no-outbound.spec.ts requires it, which is why the presence
      // WRITES live on their own service rather than here.
      'GetOperatorPresence',
      'GetPlayer',
      'ListAuditEntries',
      'ListOperatorPresence',
      // Feature 020 (roadmap 5.2): which brand-scoped records make up one human. Chats needs it to
      // answer a person's feed and cannot join across services, so identity crosses as an explicit
      // call. Editing this list is the visible act the guard exists to force.
      // Feature 024 (roadmap 5.3): AUTH user ids → assignable operator profiles. The one translation
      // that turns a group's membership into a routing candidate pool; membership keys on the auth
      // identity, an assignee is an operator profile. Named `List…` deliberately — the sibling guard
      // in tests/users-read/no-outbound.spec.ts requires every rpc here to be read-shaped, and it
      // caught the first draft, which was called `ResolveOperators`.
      'ListOperatorsByAuthUsers',
      'ListPersonMembers',
      'ListPlayersByBrand',
    ]);
  });

  it('every one of them has a handler, across the two controllers', () => {
    // Read from the SOURCE rather than from a list in this file: a fifth method added to the contract with
    // no handler must fail here, and it will, because the proto side of this test is derived too.
    const dir = join(ROOT, 'services', 'users', 'src');
    const sources = [
      readFileSync(join(dir, 'player', 'player.grpc.controller.ts'), 'utf8'),
      readFileSync(join(dir, 'audit', 'audit.grpc.controller.ts'), 'utf8'),
      // Feature 025 (roadmap 5.9): a third controller on the same service, split by SUBJECT rather
      // than by transport — the shape `AuditReadController` already established.
      readFileSync(join(dir, 'presence', 'presence.read.controller.ts'), 'utf8'),
    ].join('\n');

    const block = /service\s+UsersReadService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const declared = [...block.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    // ⚠️ `String.raw`, and the reason is a bug this test had on its first run: inside an ordinary template
    // literal `\s` is an unrecognised escape and collapses to `s`, so the pattern silently became
    // `@GrpcMethod('UsersReadService',s*'...')` and matched nothing — reporting every method as unhandled.
    // A test that fails for its own reasons is worse than no test, because the next reader believes the
    // product is broken.
    const normalised = sources.replace(/\s+/g, ' ');
    const unhandled = declared.filter(
      (rpc) => !normalised.includes(`@GrpcMethod('UsersReadService', '${rpc}')`),
    );
    expect(unhandled).toEqual([]);
  });

  it('both controllers are registered in the app module', () => {
    // A controller nobody registers contributes no handlers, and the service answers UNIMPLEMENTED while
    // looking perfectly healthy — the same defect one level up.
    const controllers = Reflect.getMetadata('controllers', AppModule) as unknown[];
    const names = controllers.map((c) => (c as { name?: string })?.name ?? '');
    expect(names).toContain('PlayerReadController');
    expect(names).toContain('AuditReadController');
  });

  it('the presence controllers reach the graph through their module', () => {
    // The third controller is registered by PresenceModule rather than listed here directly — so the
    // link that must exist is the module IMPORT, which is precisely the link feature 015 was missing.
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(PresenceModule);
    const controllers = Reflect.getMetadata('controllers', PresenceModule) as unknown[];
    const names = controllers.map((c) => (c as { name?: string })?.name ?? '');
    expect(names).toContain('PresenceReadController');
    expect(names).toContain('PresenceController');
  });
});

/**
 * T028/T032 (feature 025, roadmap 5.9) — **`OperatorPresenceService` is hosted, not merely written.**
 *
 * The third time this product adds a new gRPC service to an existing package, and the third time it
 * is asserted rather than assumed. "No new package entry is needed" is true and is exactly the kind
 * of true statement that stops anyone checking the other three links.
 */
describe('*** OperatorPresenceService is hosted, not merely written ***', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');

  it('the service is declared in the proto the users server loads', () => {
    expect(proto).toMatch(/service\s+OperatorPresenceService\s*\{/);
  });

  it('its package is the one already hosted — verified, not assumed', () => {
    const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(proto)?.[1];
    expect(declared).toBe(USERS_PACKAGE);
  });

  it('every declared rpc has a handler', () => {
    const src = readFileSync(
      join(ROOT, 'services', 'users', 'src', 'presence', 'presence.grpc.controller.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const block = /service\s+OperatorPresenceService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const declared = [...block.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);

    expect(declared.length).toBe(7); // the pattern found the block, and the surface is pinned
    const unhandled = declared.filter(
      (rpc) => !src.includes(`@GrpcMethod('OperatorPresenceService', '${rpc}')`),
    );
    expect(unhandled).toEqual([]);
  });

  it('the sweep rpc is on the MAINTENANCE service, not the presence one', () => {
    // Placement is the security property, not a filing preference: `UsersMaintenanceService` is
    // system-actor-only with no gateway route, so a sweep there cannot be invoked by a session. On
    // the presence service it would be a way to put a colleague offline without holding the key that
    // governs exactly that.
    const maintenance = /service\s+UsersMaintenanceService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const presence = /service\s+OperatorPresenceService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    expect(maintenance).toMatch(/rpc\s+SweepIdlePresence\s*\(/);
    expect(presence).not.toMatch(/SweepIdlePresence/);
  });
});

/**
 * T025 (feature 021, roadmap 5.6) — **`OperatorUiPreferencesService` is SERVED, not merely written.**
 *
 * A NEW gRPC service in an EXISTING package: the case most likely to be assumed rather than checked,
 * because "no new package entry is needed" sounds like nothing to verify. It is exactly what feature
 * 015 got wrong live — `users` hosted only the health and ping packages, so a federated read failed
 * against a service that was up, healthy and answering. All four links are asserted rather than
 * reasoned about.
 */
describe('*** OperatorUiPreferencesService is hosted, not merely written ***', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');

  it('the service and both rpcs are declared in the proto the users server loads', () => {
    expect(proto).toMatch(/service\s+OperatorUiPreferencesService\s*\{/);
    expect(proto).toMatch(/rpc\s+GetOperatorUiPreferences\s*\(/);
    expect(proto).toMatch(/rpc\s+UpdateOperatorUiPreferences\s*\(/);
  });

  it('its package is the one already hosted — verified, not assumed', () => {
    const declared = /^\s*package\s+([\w.]+)\s*;/m.exec(proto)?.[1];
    expect(declared).toBe(USERS_PACKAGE);
  });

  it('every declared rpc has a handler', () => {
    // Derived from the proto, so a third rpc added to the contract with no handler fails here.
    const src = readFileSync(
      join(ROOT, 'services', 'users', 'src', 'preferences', 'ui-preferences.grpc.controller.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    const block = /service\s+OperatorUiPreferencesService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const declared = [...block.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);

    expect(declared.length).toBeGreaterThan(0); // the pattern found the block at all
    const unhandled = declared.filter(
      (rpc) => !src.includes(`@GrpcMethod('OperatorUiPreferencesService', '${rpc}')`),
    );
    expect(unhandled).toEqual([]);
  });

  it('the controller is registered in its module', () => {
    const controllers = Reflect.getMetadata('controllers', UiPreferencesModule) as unknown[];
    expect(controllers).toContain(UiPreferencesController);
  });

  it('the module is imported by the app module — the link that was missing in 015', () => {
    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    expect(imports).toContain(UiPreferencesModule);
  });
});
