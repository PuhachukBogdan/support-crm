import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { RedisService } from './queue/redis.service';

// Phase 1 (spec 003): the worker is a gRPC microservice exposing HealthService.Check over
// its Redis connection (via BullMQ). Real job producers/consumers arrive in Phase 7.
@Module({
  controllers: [HealthGrpcController],
  providers: [RedisService],
})
export class AppModule {}
