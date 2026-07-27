-- Feature 016 (roadmap 4.9): the upload record — SEC-1, the first Category-1 P0 this project closes.
--
-- Additive: a new table, nothing reshaped, no data move. It applies to a users_db already carrying
-- feature 015's audit entries (Track B B2 asserts exactly that against the populated database).
--
-- The row DESCRIBES bytes it never holds; the bytes live in a private bucket only this service can
-- reach. `storage_key` is system-generated (FR-008) and unique — a collision would mean two records
-- pointing at one object, so it is a constraint rather than an application convention.
--
-- Two indexes, both deliberate:
--   • (account_id, created_at, id) — keyset order, with `id` breaking same-instant ties (the 015 lesson).
--   • (account_id, state, created_at) — THE FUTURE RECLAIM PREDICATE (ADR 0015). Created now, while
--     the table is empty. Adding it later means adding it to a large table, and this feature is the
--     first in the product whose growth is measured in bytes rather than rows.
--
-- Applied on Track B with:
--   prisma migrate deploy --schema services/users/prisma/schema.prisma
-- ⚠️ `--schema` is not optional inside the container: without it the command resolves a different
-- schema, reports "no pending migrations", and the first query dies on a missing table (the 014 trap).

-- CreateTable
CREATE TABLE "Upload" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "uploader_user_id" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum_sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "display_name" TEXT,
    "derivative_key" TEXT,
    "derivative_byte_size" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Upload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Upload_storage_key_key" ON "Upload"("storage_key");

-- CreateIndex
CREATE INDEX "Upload_account_id_created_at_id_idx" ON "Upload"("account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "Upload_account_id_state_created_at_idx" ON "Upload"("account_id", "state", "created_at");
