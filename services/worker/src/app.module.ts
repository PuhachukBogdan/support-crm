import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { RedisService } from './queue/redis.service';
import { WorkerChatsModule } from './chats/chats.client';
import { WorkerUsersModule } from './users/users.client';
import { SlaSweepJob } from './jobs/sla-sweep.job';
import { ExportRunJob } from './jobs/export-run.job';
import { ExpirySweepJob } from './jobs/expiry-sweep.job';
// Feature 025 (roadmap 5.9): the auto-away tick. Its own queue rather than a passenger on the
// five-minute expiry sweep — the tick interval is added to the away threshold as lag.
import { PresenceSweepJob } from './jobs/presence-sweep.job';
import { MailSweepJob } from './jobs/mail-sweep.job';
import { WorkerAuthModule } from './auth/auth.client';

// Phase 1 (spec 003): the worker is a gRPC microservice exposing HealthService.Check over
// its Redis connection (via BullMQ).
//
// Feature 014 (roadmap 4.7) gives it its FIRST real job: the first-reply SLA sweep. Its role is
// scheduling only — fire a repeatable tick, call the chats maintenance RPC. It owns no database, holds
// no rule state, and decides nothing about what counts as a breach; chats owns the data and the verdict
// (research R1/R2). The rest of the job catalogue (notifications, exports, webhooks, email, scheduled
// cleanups, dead-lettering) is still roadmap 7.3.
// Feature 017 (roadmap 4.10) adds two more ticks in the same shape:
//   • `ExportRunJob` — the export queue. chats has no Redis, so a request writes a `queued` row and this
//     tick claims it.
//   • `ExpirySweepJob` — BOTH halves of expiry from one clock: `ExpireDueExports` in chats (the record)
//     and `PurgeExpiredArtefacts` in users (the bytes, which only `users` can delete because only
//     `users` holds the storage credentials). Track B found the chats half wired to nothing, which left
//     every completed export `ready` for ever with a dangling artefact reference.
@Module({
  imports: [WorkerChatsModule, WorkerUsersModule, WorkerAuthModule],
  controllers: [HealthGrpcController],
  providers: [RedisService, SlaSweepJob, ExportRunJob, ExpirySweepJob, PresenceSweepJob, MailSweepJob],
})
export class AppModule {}
