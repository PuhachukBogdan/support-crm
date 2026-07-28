import { Inject, Injectable } from '@nestjs/common';
import type { ExportScope } from '@crm/common';
import { ExportRepository } from './export.repository';

/**
 * The export quota (feature 017, US3 — FR-016/SEC-22, research R11).
 *
 * ── Why this is counted in Postgres and not by the existing rate limiter ─────────────────────────
 * Feature 010's `RateLimiter` documents itself: *"per-instance only. Multi-instance / durable
 * rate-limiting is a later hardening (Redis)"* — it keeps hits in an in-process `Map`. Under N
 * replicas the effective quota therefore becomes **N × max**. For the invite/activation flows that was
 * an accepted trade at low QPS. For a quota whose stated purpose is bounding **PII extraction volume**
 * it is not a quota at all: it would pass every Track-A test and be false in production, which is the
 * worst failure shape this project keeps finding on Track B.
 *
 * The `ExportJob` table already knows exactly how many exports this requester created and when, on an
 * index added for this query. One indexed range count per request satisfies Principle VII, and it is
 * correct across replicas because Postgres is the one thing all replicas agree on.
 *
 * The numbers are catalogue DATA (`quotaMax` / `quotaWindowSeconds`), so tightening them later is a
 * config change rather than a code change.
 */
export class QuotaExhaustedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('export quota exhausted');
    this.name = 'QuotaExhaustedError';
  }
}

@Injectable()
export class ExportQuota {
  constructor(@Inject(ExportRepository) private readonly repo: ExportRepository) {}

  /**
   * Throw {@link QuotaExhaustedError} when this requester has reached the scope's allowance.
   *
   * Checked BEFORE the row is inserted (FR-017): a refused request must queue no job, store nothing and
   * — because nothing was exported — write no audit entry. The count is of rows CREATED in the window,
   * including failed ones: a failed export still read the source data and still consumed the work, so
   * excluding failures would make "retry until it works" an unbounded path.
   */
  async assertWithinQuota(
    accountId: string,
    requestedBy: string,
    scope: ExportScope,
    now: Date,
  ): Promise<void> {
    const since = new Date(now.getTime() - scope.quotaWindowSeconds * 1000);
    const used = await this.repo.countInWindow(accountId, requestedBy, since);
    if (used >= scope.quotaMax) {
      throw new QuotaExhaustedError(scope.quotaWindowSeconds);
    }
  }
}
