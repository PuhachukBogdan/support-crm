import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { PingModule } from './ping/ping.module';
import { WsModule } from './ws/ws.module';
import { AuthEdgeModule } from './auth/auth.module';
import { SecurityModule } from './security/security.module';
import { AccessManagementModule } from './rbac/access-management.module';
import { ChatsModule } from './chats/chats.module';
import { AuditModule } from './audit/audit.module';
import { UploadsEdgeModule } from './uploads/uploads.module';

// Phase 1 (spec 003): the gateway is the single ingress (REST + WS) and a gRPC client of the
// backend services — liveness + readiness aggregate (US5), the ping round-trip (US3), and a
// WebSocket surface (US4). Feature 009 adds the session edge (AuthEdgeModule): the `/auth/*`
// REST endpoints + a GLOBAL AuthGuard (every route needs a valid session unless @Public()).
// Feature 011 adds the SecurityModule: the GLOBAL PermissionGuard (RBAC enforcement). Imported
// AFTER AuthEdgeModule so the AuthGuard (sets req.claims) runs before the PermissionGuard.
// The gateway stays routing-only — no business logic (Principle VIII).
@Module({
  imports: [
    HealthModule,
    PingModule,
    WsModule,
    AuthEdgeModule,
    SecurityModule,
    AccessManagementModule,
    ChatsModule,
    // Feature 015 (roadmap 4.8): the federated audit read surface.
    AuditModule,
    // Feature 016 (roadmap 4.9): the one validated upload path — SEC-1.
    UploadsEdgeModule,
  ],
})
export class AppModule {}
