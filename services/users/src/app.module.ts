import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PingGrpcController } from './ping/ping.controller';
import { PrismaService } from './prisma.service';
import { PlayerRepository } from './player/player.repository';
import { ContactViewAuditService } from './player/contact-view-audit.service';

// Phase 1 (spec 003): the users service hosts TWO gRPC packages — HealthService.Check
// (over its own Postgres) and PingService (the US3 cross-service round-trip target).
// Phase 2 (feature 006): the Player read path (PlayerRepository) lands here; the gRPC
// UsersReadService handlers that expose it arrive in Phase 5.
// Feature 011 (US4): anti-pitching masking (player.masking) + the contact-view audit
// (ContactViewAuditService) — the masking + audit units the player-read handlers call in Phase 5.
@Module({
  controllers: [HealthGrpcController, PingGrpcController],
  providers: [PrismaService, PlayerRepository, ContactViewAuditService],
})
export class AppModule {}
