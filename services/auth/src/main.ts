import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logInfo } from '@crm/common';
import { AppModule } from './app.module';

// Phase 0: bootable shell — proves the service's Nest module wiring compiles and
// initializes. No HTTP/gRPC surface or domain logic yet (auth = Phase 3).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  logInfo('auth', 'service context initialized (Phase 0 shell)');
  await app.close();
}

void bootstrap();
