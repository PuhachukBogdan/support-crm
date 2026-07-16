import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logInfo } from '@crm/common';
import { AppModule } from './app.module';

// Phase 0: bootable shell — proves module wiring compiles and initializes. No domain logic yet.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  logInfo('users', 'service context initialized (Phase 0 shell)');
  await app.close();
}

void bootstrap();
