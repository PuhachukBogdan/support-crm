import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { logInfo } from '@crm/common';
import { AppModule } from './app.module';

// Phase 0: bootable BullMQ-consumer shell — proves module wiring compiles and initializes.
// No queues or jobs yet (BullMQ + Redis land in Phase 1).
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  logInfo('worker', 'worker context initialized (Phase 0 shell — no jobs yet)');
  await app.close();
}

void bootstrap();
