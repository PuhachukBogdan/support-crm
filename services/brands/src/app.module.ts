import { Module } from '@nestjs/common';

// Phase 0: empty module shell. This is the structural seam where brand/tenant scoping
// (Principle I isolation) will live from Phase 2. No isolation logic exists yet.
@Module({})
export class AppModule {}
