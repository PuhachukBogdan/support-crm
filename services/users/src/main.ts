import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import {
  grpcServerOptions,
  HEALTH_PACKAGE,
  HEALTH_PROTO,
  PING_PACKAGE,
  PING_PROTO,
  logInfo,
} from '@crm/common';
import { AppModule } from './app.module';
import { loadUsersConfig } from './config';

// Phase 1 (spec 003): users boots as a gRPC microservice hosting BOTH the health and ping
// packages. loadUsersConfig() runs FIRST — refuse-to-start on missing/placeholder config
// before any connection (SEC-6 / US2).
async function bootstrap(): Promise<void> {
  const cfg = loadUsersConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    grpcServerOptions(
      [HEALTH_PACKAGE, PING_PACKAGE],
      [HEALTH_PROTO, PING_PROTO],
      cfg.GRPC_URL,
    ),
  );
  await app.listen();
  logInfo('users', `users gRPC server listening on ${cfg.GRPC_URL}`);
}

void bootstrap();
