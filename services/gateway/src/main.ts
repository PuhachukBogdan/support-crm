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
// ── ⭐ Feature 033 (roadmap 6.1, research R3): RAW BODIES, for the one signed route ────────────────
//
// The channel intake route verifies an HMAC over EXACTLY THE BYTES THAT ARRIVED. Nest parses JSON by
// default and hands the controller an object; re-serialising that object produces a different byte string
// — different key order, different whitespace, different unicode escaping — so every signature would fail
// and the symptom would read as *"the provider signs wrongly"*, which is the hardest kind of bug to
// attribute because the other party looks responsible.
//
// `rawBody: true` keeps the untouched buffer alongside the parsed body. It changes nothing for any existing
// route: the parsed body is still there, and the raw copy is only read by the one controller that needs it.
//
// ⚠️ The gateway still does NO verification — it holds no channel secret. It preserves the bytes and
// forwards them to chats, which owns the channel row and therefore the secret (Principle VIII).
async function bootstrap(): Promise<void> {
  const cfg = loadGatewayConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(helmet(helmetOptions));
  app.use(cookieParser());
  // Native `ws` adapter — REST and WS share the same underlying HTTP server/port (FR-009).
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(cfg.GATEWAY_PORT);
  logInfo('gateway', `API Gateway (REST + WS) listening on :${cfg.GATEWAY_PORT}`);
}

void bootstrap();
