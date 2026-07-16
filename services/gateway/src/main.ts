import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SERVICE_NAMES, logInfo } from '@crm/common';
import { AppModule } from './app.module';

// US2: the gateway boots and serves the /health liveness contract.
// US1 (T013): importing SERVICE_NAMES/logInfo from @crm/common proves cross-workspace linking.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.GATEWAY_PORT ?? 3000) || 3000;
  await app.listen(port);
  logInfo('gateway', `API Gateway listening on :${port}`, {
    services: [...SERVICE_NAMES],
  });
}

void bootstrap();
