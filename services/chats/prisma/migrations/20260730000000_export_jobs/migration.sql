-- Feature 017 (roadmap 4.10): one data export.
--
-- Additive: a new table, nothing reshaped. `upload_id` is a SOFT reference to `users.Upload.id` — no
-- foreign key here and none possible, because the two tables live in different databases (Principle
-- VIII). The reference is created by the gRPC call that stores the artefact, and the account boundary
-- is enforced there, on the users side, by the same actor metadata that owns the row.
--
-- ── Why four indexes on a small table ────────────────────────────────────────────────────────────
-- Each serves a query this feature actually makes, and two of them deliberately do NOT start with
-- account_id:
--   • (account_id, created_at, id)          — the caller's own list, keyset order; `id` breaks
--                                             same-instant ties (the lesson from feature 015's
--                                             federated cursor).
--   • (account_id, requested_by, created_at)— the quota count (research R11). The quota is counted in
--                                             Postgres rather than by feature 010's RateLimiter,
--                                             because that limiter is per-instance in-memory and under
--                                             N replicas the quota would silently become N × max.
--   • (status, claimed_at)                  — the RunDueExports claim predicate and stale-claim
--                                             recovery. Serves the system-actor sweep, which is
--                                             id-only and fenced exactly as 014's SLA sweep is.
--   • (status, expires_at)                  — the ExpireDueExports predicate, same reasoning.
--
-- ── expires_at is NOT NULL, on purpose ──────────────────────────────────────────────────────────
-- An export without an expiry is an artefact that outlives its authorization, which is SEC-27 itself.
-- The value is computed at creation from the scope catalogue's TTL, and the same value is written to
-- `users.Upload.expires_at` so the credential holder can purge the bytes without asking anyone
-- (research R7).
--
-- Applied on Track B with:
--   prisma migrate deploy --schema services/chats/prisma/schema.prisma
--   (the --schema flag is mandatory inside the container: without it, migrate deploy reports
--    "no pending migrations" against the wrong schema and the sweep then fails on a missing table)

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "filters_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "row_count" INTEGER,
    "byte_size" INTEGER,
    "upload_id" TEXT,
    "failure_reason" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExportJob_account_id_created_at_id_idx" ON "ExportJob"("account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "ExportJob_account_id_requested_by_created_at_idx" ON "ExportJob"("account_id", "requested_by", "created_at");

-- CreateIndex
CREATE INDEX "ExportJob_status_claimed_at_idx" ON "ExportJob"("status", "claimed_at");

-- CreateIndex
CREATE INDEX "ExportJob_status_expires_at_idx" ON "ExportJob"("status", "expires_at");
