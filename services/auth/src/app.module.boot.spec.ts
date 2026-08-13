import 'reflect-metadata';
import { Test } from '@nestjs/testing';

/**
 * ⚠️ Set BEFORE the module is imported: `loadAuthConfig` runs the SEC-6 refuse-to-start gate at
 * construction, and it is right to. These are syntactically valid throwaways — the test proves the
 * container can WIRE the service, never that any of these values reach anything.
 */
process.env.APP_BASE_URL ??= 'http://localhost:3001';
process.env.DATABASE_URL ??= 'postgresql://u:p@127.0.0.1:5432/auth_db?schema=public';
process.env.GRPC_URL ??= '127.0.0.1:50051';
process.env.JWT_SECRET ??= 'a-test-only-secret-of-at-least-32-characters';
process.env.MAIL_FROM ??= 'crm@example.test';
process.env.MAIL_HOST ??= 'mailpit';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('./app.module') as { AppModule: unknown };

/**
 * ⭐ W31 / feature 038 — **the service can actually BOOT.**
 *
 * ── The defect this exists because of, in full ──────────────────────────────────────────────────
 * `ProvisioningService` takes `InviteService` and `RefreshService`, both of which live in
 * `AuthModule` and neither of which was EXPORTED. Nest could not resolve them, and the auth service
 * died at startup with `UnknownDependenciesException` — no login, no anything.
 *
 * **Every unit test in this service passed through all of it.** They construct their subjects
 * directly (`new ProvisioningService(repo, invites, refresh, audit)`), which is the right way to
 * write them and is precisely why they are blind here: a spec that hands a class its collaborators
 * cannot discover that the container has no way to find them. The suite was green, the typecheck was
 * green, the lint was green, and the process would not start.
 *
 * It was caught by the first live run on the stand — rule 10's corollary («a page nobody has opened
 * is not verified») earning its keep again. This test is that live run's cheap half: it fails in
 * ~2 seconds on a laptop instead of after a build, a push and a deploy.
 *
 * ── Why compiling the WHOLE module, rather than asserting an export list ────────────────────────
 * An export list is a restatement of the fix, so it would pass for the next missing provider too.
 * Compiling asks Nest the actual question — *can you construct everything this service declares?* —
 * and so it covers dependencies nobody has added yet.
 *
 * ⓘ `.compile()` constructs providers; it does not call `onModuleInit`, so nothing opens a database
 * connection, a socket or a queue. That is what makes this affordable as an ordinary unit test.
 */
describe('*** the auth service can be constructed — every dependency resolves ***', () => {
  it('AppModule compiles', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule as never] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 30_000);
});
