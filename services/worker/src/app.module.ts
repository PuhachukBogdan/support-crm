import { Module } from '@nestjs/common';

// Phase 0: empty module shell for the background-job service. BullMQ queues/consumers
// are wired in Phase 1 (Redis) and populated with real jobs from Phase 6/12. No jobs yet.
@Module({})
export class AppModule {}
