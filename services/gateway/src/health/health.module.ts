import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import { GrpcClientsModule } from '../grpc/clients.module';
import { RedisModule } from '../redis/redis.module';

// Liveness (/health) + dependency-aware readiness (/health/ready). Readiness fans out over
// the gRPC health clients and checks the gateway's own Redis (spec 003, US5).
//
// ⓘ `RedisService` moved to its own module in feature 034: the realtime edge needs the same connection,
// and declaring the provider in two modules would have made it two connections.
@Module({
  imports: [GrpcClientsModule, RedisModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class HealthModule {}
