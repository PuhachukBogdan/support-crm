import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { withAccountScope } from '@crm/common';
// This service's OWN generated client (feature 006) — DB-per-service (research R1).
// Regenerate with `npm run prisma:gen`; the output dir is git-ignored.
import { PrismaClient } from './generated/prisma';
import { SCOPED_MODELS } from './prisma.scoped-models';

/**
 * Per-service Prisma client (spec 003, US5 / FR-011). Reads DATABASE_URL from the env
 * (each service has its OWN database + role — isolation). Backed by users_db
 * (services/users/prisma/schema.prisma). Health uses `$queryRaw`SELECT 1``.
 *
 * Deliberately does NOT connect at boot — a downed database must DEGRADE health, not crash
 * startup (FR-012). Prisma connects lazily on first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch(() => undefined);
  }

  /**
   * The ONLY sanctioned path to tenant data: a client confined to `accountId` (feature 007,
   * Principle I). Throws when no account context is supplied (fail-closed). The raw `this` client
   * is reserved for account-free paths (health `SELECT 1`, migrations) — an audited escape hatch.
   */
  forAccount(accountId: string) {
    return withAccountScope(this, accountId, { scopedModels: SCOPED_MODELS });
  }
}
