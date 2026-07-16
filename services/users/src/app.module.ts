import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PingGrpcController } from './ping/ping.controller';
import { PrismaService } from './prisma.service';

// Phase 1 (spec 003): the users service hosts TWO gRPC packages — HealthService.Check
// (over its own Postgres) and PingService (the US3 cross-service round-trip target).
// Users domain logic arrives in Phase 5.
@Module({
  controllers: [HealthGrpcController, PingGrpcController],
  providers: [PrismaService],
})
export class AppModule {}
