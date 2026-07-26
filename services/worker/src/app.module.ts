import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { RedisService } from './queue/redis.service';
import { WorkerChatsModule } from './chats/chats.client';
import { SlaSweepJob } from './jobs/sla-sweep.job';

// Phase 1 (spec 003): the worker is a gRPC microservice exposing HealthService.Check over
// its Redis connection (via BullMQ).
//
// Feature 014 (roadmap 4.7) gives it its FIRST real job: the first-reply SLA sweep. Its role is
// scheduling only — fire a repeatable tick, call the chats maintenance RPC. It owns no database, holds
// no rule state, and decides nothing about what counts as a breach; chats owns the data and the verdict
// (research R1/R2). The rest of the job catalogue (notifications, exports, webhooks, email, scheduled
// cleanups, dead-lettering) is still roadmap 7.3.
@Module({
  imports: [WorkerChatsModule],
  controllers: [HealthGrpcController],
  providers: [RedisService, SlaSweepJob],
})
export class AppModule {}
