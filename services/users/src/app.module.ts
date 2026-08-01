import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PingGrpcController } from './ping/ping.controller';
import { PrismaService } from './prisma.service';
import { PlayerRepository } from './player/player.repository';
import { ContactViewAuditService } from './player/contact-view-audit.service';
// Feature 015 (roadmap 4.8): the audit trail — this service's source of the federated log.
import { AuditRepository } from './audit/audit.repository';
import { AuditReadController } from './audit/audit.grpc.controller';
import { AuditAccessGuard } from './audit/audit.guard';
// Feature 016 (roadmap 4.9): the one validated upload path. `users` is the only service holding
// object-store credentials (research R1/R2) — SEC-1.
import { UploadsModule } from './uploads/uploads.module';
// Feature 017 (roadmap 4.10): `UsersMaintenanceService.PurgeExpiredArtefacts` — expiry enforced as
// DELETION. System actor only, no gateway route. Registering the controller is what makes the RPC
// actually served: feature 015's single live-only defect was a hosted PACKAGE whose handler was never
// wired, so the fan-out failed against a service that looked up.
import { MaintenanceModule } from './maintenance/maintenance.module';
// Feature 018 (roadmap 5.1): the operator read path. Its own folder because a STAFF read has genuinely
// different rules from a customer read — no tier masking, no access audit — and putting the two side by
// side invites one to inherit the other's treatment by proximity.
import { OperatorRepository } from './operator/operator.repository';
import { PlayerAccessGuard } from './player/player.guard';
import { PlayerReadController } from './player/player.grpc.controller';
import { PersonService } from './player/person.service';
// Feature 021 (roadmap 5.6): the OPERATOR's own appearance settings — cosmetic, self-owned, gated by
// no permission, written to no audit trail. Its own module because every neighbouring surface here is
// the opposite on all four counts. NOT `Player.preferences_json`, which is the customer's data.
import { UiPreferencesModule } from './preferences/ui-preferences.module';
// Feature 025 (roadmap 5.9): agent presence. Its READ handlers ride the existing player controller's
// service (`UsersReadService`), because a guard requires every rpc there to be read-shaped; the
// writes are a new service in the same package, which is why no new hosting entry is needed — a
// claim `hosting.spec.ts` verifies rather than accepts.
import { PresenceModule } from './presence/presence.module';
// Feature 026 (roadmap 5.7): player ↔ AM attachment. Its repository is exported because the PLAYER
// read path needs it — the narrowing asks the attachment a question on every masked read.
import { AssignmentModule } from './assignment/assignment.module';

// Phase 1 (spec 003): the users service hosts TWO gRPC packages — HealthService.Check
// (over its own Postgres) and PingService (the US3 cross-service round-trip target).
// Phase 2 (feature 006): the Player read path (PlayerRepository) lands here; the gRPC
// UsersReadService handlers that expose it arrive in Phase 5.
// Feature 011 (US4): anti-pitching masking (player.masking) + the contact-view audit
// (ContactViewAuditService).
// Feature 018 (roadmap 5.1): those units are now WIRED — the `UsersReadService` player/operator handlers
// that call them land here, closing the "arrive in Phase 5" note this comment has carried since Phase 2.
// The player controller registers itself alongside; this list holds the repositories it depends on.
@Module({
  imports: [
    UploadsModule,
    MaintenanceModule,
    UiPreferencesModule,
    PresenceModule,
    AssignmentModule,
  ],
  controllers: [HealthGrpcController, PingGrpcController, AuditReadController, PlayerReadController],
  providers: [
    PersonService,
    PrismaService,
    PlayerRepository,
    OperatorRepository,
    ContactViewAuditService,
    AuditRepository,
    AuditAccessGuard,
    PlayerAccessGuard,
  ],
})
export class AppModule {}
