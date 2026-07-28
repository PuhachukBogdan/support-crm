import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import {
  grpcServerOptions,
  HEALTH_PACKAGE,
  HEALTH_PROTO,
  PING_PACKAGE,
  PING_PROTO,
  USERS_PACKAGE,
  USERS_PROTO,
  UPLOAD_SERVER_CHANNEL_OPTIONS,
  logInfo,
} from '@crm/common';
import { AppModule } from './app.module';
import { loadUsersConfig } from './config';

// Phase 1 (spec 003): users boots as a gRPC microservice hosting the health and ping packages.
// Feature 015 adds the USERS package: `UsersReadService.ListAuditEntries` is this service's source of the
// federated audit trail, and until it was hosted the gateway's fan-out failed here — caught on the first
// live run, because the federation deliberately treats an unreadable source as an ERROR rather than a
// silently short page. The player read handlers on the same service arrive in Phase 5.
//
// Feature 017 adds `UsersMaintenanceService.PurgeExpiredArtefacts` — declared in the SAME proto file and
// therefore in the SAME package (`crm.users.v1`), so this list needs no new entry. That is exactly the
// trap 015 fell into from the other side, so it is asserted rather than reasoned about:
// `maintenance/hosting.spec.ts` checks the proto's package against USERS_PACKAGE and checks that the
// handler's controller is actually in the module graph. A hosted package with an unwired handler is a
// service that looks up and answers UNIMPLEMENTED.
// loadUsersConfig() runs FIRST — refuse-to-start on missing/placeholder config before any connection
// (SEC-6 / US2).
async function bootstrap(): Promise<void> {
  const cfg = loadUsersConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    grpcServerOptions(
      [HEALTH_PACKAGE, PING_PACKAGE, USERS_PACKAGE],
      [HEALTH_PROTO, PING_PROTO, USERS_PROTO],
      cfg.GRPC_URL,
      // Feature 016: this server receives whole files on `UploadsService.CreateUpload`, so its
      // message ceiling is raised to 12 MB — on this service only. The arithmetic behind the number
      // is in `UPLOAD_CHANNEL_BYTES` (research R2).
      UPLOAD_SERVER_CHANNEL_OPTIONS,
    ),
  );
  await app.listen();
  logInfo('users', `users gRPC server listening on ${cfg.GRPC_URL}`);
}

void bootstrap();
