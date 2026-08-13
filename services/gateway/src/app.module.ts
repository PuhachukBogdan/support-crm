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
import { ExportsEdgeModule } from './exports/exports.module';
// Feature 018 (roadmap 5.1): the players + operators read edge. Exists so the SECOND authorization tier
// is exercised by something real and so the point can be validated live — no screen, no write.
import { PlayersEdgeModule } from './players/players.module';
// Feature 021 (roadmap 5.6): `/me/ui-preferences` — the OPERATOR's own theme and font size. The only
// edge in this list gated by NO permission, deliberately: a preference may never decide what someone
// is allowed to see (ADR 0035's hard boundary). NOT `Player.preferences_json`.
import { UiPreferencesEdgeModule } from './preferences/ui-preferences.module';
import { MeOperatorModule } from './operator/me-operator.module';
// Feature 024 (roadmap 5.3): the groups edge — a thin proxy plus the cache invalidation that
// makes a revoked group grant take effect on the very next request.
import { GroupsEdgeModule } from './groups/groups.module';
// Feature 025 (roadmap 5.9): the presence edge. Caches NOTHING, deliberately — see its module.
import { PresenceEdgeModule } from './presence/presence.module';
// Feature 026 (roadmap 5.7): the player↔AM assignment edge. Also caches nothing, and for a sharper
// reason — an attachment decides what somebody may READ.
import { AssignmentEdgeModule } from './assignment/assignment.module';
import { ProvisioningEdgeModule } from './provisioning/provisioning.module';

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
    // Feature 017 (roadmap 4.10): the exports edge. Issues no links and holds no storage config.
    ExportsEdgeModule,
    PlayersEdgeModule,
    UiPreferencesEdgeModule,
    // Roadmap 5.11 (MVP block W5): "which operator am I?" — the self-scoped translation the Inbox's
    // "Your work" and the agent rail stand on.
    MeOperatorModule,
    GroupsEdgeModule,
    PresenceEdgeModule,
    AssignmentEdgeModule,
    // ⭐ W31 / feature 038 (roadmap 3.15 + 3.17): the HR platform's machine boundary and the admin
    // screen that cuts its keys. The ONLY module here holding a `@Public()` write route.
    ProvisioningEdgeModule,
  ],
})
export class AppModule {}
