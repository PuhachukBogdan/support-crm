import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PingGrpcController } from './ping/ping.controller';
import { PrismaService } from './prisma.service';
import { PlayerRepository } from './player/player.repository';

// Phase 1 (spec 003): the users service hosts TWO gRPC packages — HealthService.Check
// (over its own Postgres) and PingService (the US3 cross-service round-trip target).
// Phase 2 (feature 006): the Player read path (PlayerRepository) lands here; the gRPC
// UsersReadService handlers that expose it arrive in Phase 5.
@Module({
  controllers: [HealthGrpcController, PingGrpcController],
  providers: [PrismaService, PlayerRepository],
})
export class AppModule {}
