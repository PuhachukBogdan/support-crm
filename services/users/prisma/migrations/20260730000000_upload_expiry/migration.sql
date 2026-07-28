-- Feature 017 (roadmap 4.10): when an artefact's bytes stop being allowed to exist.
--
-- One nullable column and one index. Nullable is the correct shape and not a convenience: an expiry is
-- meaningful ONLY for a purpose declared `ephemeral`, and today that is exactly one purpose
-- (`conversation_export`). A message attachment and an avatar must never acquire one — the upload
-- catalogue's own comment warns that a reclaim job keyed on such a flag would delete avatars in active
-- use, so `purposes.spec.ts` fails the build if an `ingested` purpose is ever marked ephemeral.
--
-- Why the predicate lives HERE and not only on the export record: deletion must be executable by the
-- component that holds the storage credentials, without asking another service. A purge that depends on
-- chats being reachable is a purge that stops silently, and an artefact whose expiry is only a status
-- flag while the bytes sit in a bucket is SEC-27 rather than a fix for it (research R7/R8).
--
-- The index is deliberately NOT account-scoped: the sweep runs as a system actor with no tenant context
-- and selects ids only, fenced exactly as feature 014's SLA sweep is (ids only, counts-only response,
-- system actor, no gateway route, batch-capped). Every write that follows still goes through forAccount.
--
-- Applied on Track B with:
--   prisma migrate deploy --schema services/users/prisma/schema.prisma

-- AlterTable
ALTER TABLE "Upload" ADD COLUMN "expires_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Upload_purpose_expires_at_idx" ON "Upload"("purpose", "expires_at");
