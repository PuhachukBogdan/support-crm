import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { grpcServerOptions, HEALTH_PACKAGE, HEALTH_PROTO, logInfo } from '@crm/common';
import { AppModule } from './app.module';
import { loadChatsConfig } from './config';

// Phase 1 (spec 003): chats boots as a gRPC microservice exposing HealthService.Check.
// loadChatsConfig() runs FIRST — the process refuses to start (non-zero exit) on any
// missing/placeholder config, before any connection is opened (SEC-6 / US2).
async function bootstrap(): Promise<void> {
  const cfg = loadChatsConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    grpcServerOptions(HEALTH_PACKAGE, HEALTH_PROTO, cfg.GRPC_URL),
  );
  await app.listen();
  logInfo('chats', `chats gRPC server listening on ${cfg.GRPC_URL}`);
}

void bootstrap();
