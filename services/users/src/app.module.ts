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

// Phase 1 (spec 003): the users service hosts TWO gRPC packages — HealthService.Check
// (over its own Postgres) and PingService (the US3 cross-service round-trip target).
// Phase 2 (feature 006): the Player read path (PlayerRepository) lands here; the gRPC
// UsersReadService handlers that expose it arrive in Phase 5.
// Feature 011 (US4): anti-pitching masking (player.masking) + the contact-view audit
// (ContactViewAuditService) — the masking + audit units the player-read handlers call in Phase 5.
@Module({
  imports: [UploadsModule, MaintenanceModule],
  controllers: [HealthGrpcController, PingGrpcController, AuditReadController],
  providers: [PrismaService, PlayerRepository, ContactViewAuditService, AuditRepository, AuditAccessGuard],
})
export class AppModule {}
