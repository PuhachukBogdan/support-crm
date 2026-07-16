import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { PingModule } from './ping/ping.module';
import { WsModule } from './ws/ws.module';

// Phase 1 (spec 003): the gateway is the single ingress (REST + WS) and a gRPC client of the
// backend services — liveness + readiness aggregate (US5), the ping round-trip (US3), and a
// WebSocket surface (US4). JWT validation + routing/RBAC arrive in Phase 3 (gateway stays
// routing-only — no business logic, Principle VIII).
@Module({
  imports: [HealthModule, PingModule, WsModule],
})
export class AppModule {}
