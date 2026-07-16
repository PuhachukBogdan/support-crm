import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Per-service Prisma client (spec 003, US5 / FR-011). Reads DATABASE_URL from the env
 * (each service has its OWN database + role — isolation). Datasource-only schema for now:
 * health uses `$queryRaw`SELECT 1``; real models arrive in Phase 2.
 *
 * Deliberately does NOT connect at boot — a downed database must DEGRADE health, not crash
 * startup (FR-012). Prisma connects lazily on first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => undefined);
  }
}
