import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { MicroserviceOptions } from '@nestjs/microservices';
import {
  grpcServerOptions,
  AUTH_PACKAGE,
  AUTH_PROTO,
  HEALTH_PACKAGE,
  HEALTH_PROTO,
  logInfo,
} from '@crm/common';
import { AppModule } from './app.module';
import { loadAuthConfig, parseFixedLoginCodeEmails } from './config';

// Phase 1 (spec 003): auth boots as a gRPC microservice exposing HealthService.Check.
// Feature 009: it now ALSO serves the AuthService package (login/verify/validate). Both proto
// packages are hosted on the one gRPC bind address. loadAuthConfig() runs FIRST — the process
// refuses to start (non-zero exit) on any missing/placeholder config, including JWT_SECRET,
// before any connection is opened (SEC-6 / US2).
async function bootstrap(): Promise<void> {
  const cfg = loadAuthConfig();
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AppModule,
    grpcServerOptions([HEALTH_PACKAGE, AUTH_PACKAGE], [HEALTH_PROTO, AUTH_PROTO], cfg.GRPC_URL),
  );
  await app.listen();
  logInfo('auth', `auth gRPC server listening on ${cfg.GRPC_URL}`);

  // ⚠️ A fixed sign-in code is a permanent second factor for the accounts it covers. It is a stand
  // convenience and it must never be something one discovers by accident, so it says so on every
  // boot. The COUNT, never the addresses (Principle IV) and never the code itself.
  const fixedFor = parseFixedLoginCodeEmails(cfg.DEV_FIXED_LOGIN_CODE_EMAILS).length;
  if (fixedFor > 0 && cfg.DEV_FIXED_LOGIN_CODE !== '') {
    logInfo(
      'auth',
      'WARNING: a FIXED sign-in code is active — the emailed code is the same every time for ' +
        `${fixedFor} configured account(s). Unset DEV_FIXED_LOGIN_CODE* before any real data.`,
    );
  }
}

void bootstrap();
