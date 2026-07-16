import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import { grpcServerOptions, HEALTH_PACKAGE, HEALTH_PROTO, logInfo } from '@crm/common';
import { AppModule } from './app.module';
import { loadWorkerConfig } from './config';

// Phase 1 (spec 003): worker boots as a gRPC microservice exposing HealthService.Check.
// loadWorkerConfig() runs FIRST — refuse-to-start on missing/placeholder config (SEC-6).
async function bootstrap(): Promise<void> {
  const cfg = loadWorkerConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    grpcServerOptions(HEALTH_PACKAGE, HEALTH_PROTO, cfg.GRPC_URL),
  );
  await app.listen();
  logInfo('worker', `worker gRPC server listening on ${cfg.GRPC_URL}`);
}

void bootstrap();
