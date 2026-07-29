import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USERS_PACKAGE, USERS_PROTO } from '@crm/common';
import { AppModule } from '../app.module';
import { MaintenanceModule } from './maintenance.module';
import { MaintenanceController } from './maintenance.controller';

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
describe('*** UsersReadService is served across two controllers, completely ***', () => {
  const proto = readFileSync(USERS_PROTO, 'utf8');

  it('the contract declares exactly five methods on it', () => {
    const block = /service\s+UsersReadService\s*\{([\s\S]*?)\n\}/.exec(proto)?.[1] ?? '';
    const rpcs = [...block.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    expect(rpcs.sort()).toEqual([
      'GetOperator',
      'GetPlayer',
      'ListAuditEntries',
      // Feature 020 (roadmap 5.2): which brand-scoped records make up one human. Chats needs it to
      // answer a person's feed and cannot join across services, so identity crosses as an explicit
      // call. Editing this list is the visible act the guard exists to force.
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
});
