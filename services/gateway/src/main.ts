import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { logInfo } from '@crm/common';
import { AppModule } from './app.module';
import { loadGatewayConfig } from './config';
import { helmetOptions } from './security/csp';

// Phase 1 (spec 003): the gateway serves REST + WebSocket on ONE host/port (US4) and dials
// the backend services over gRPC. loadGatewayConfig() runs FIRST — refuse-to-start on any
// missing/placeholder config before the server binds (SEC-6 / US2).
// Feature 009: the gateway is the session edge — baseline CSP (helmet, SEC-12) on every
// response and cookie-parser so the AuthGuard can read the httpOnly session cookie.
async function bootstrap(): Promise<void> {
  const cfg = loadGatewayConfig();
  const app = await NestFactory.create(AppModule);
  app.use(helmet(helmetOptions));
  app.use(cookieParser());
  // Native `ws` adapter — REST and WS share the same underlying HTTP server/port (FR-009).
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(cfg.GATEWAY_PORT);
  logInfo('gateway', `API Gateway (REST + WS) listening on :${cfg.GATEWAY_PORT}`);
}

void bootstrap();
