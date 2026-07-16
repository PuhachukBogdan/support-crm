import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';
import { GrpcClientsModule } from '../grpc/clients.module';
import { RedisService } from '../redis/redis.service';

// Liveness (/health) + dependency-aware readiness (/health/ready). Readiness fans out over
// the gRPC health clients and checks the gateway's own Redis (spec 003, US5).
@Module({
  imports: [GrpcClientsModule],
  controllers: [HealthController],
  providers: [ReadinessService, RedisService],
})
export class HealthModule {}
