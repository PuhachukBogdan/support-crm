-- Feature 012 (roadmap 4.2): capture @mentions on private notes.
-- Operator-id soft refs; capture-only (resolution/validation deferred to Phase 5, research R6).
-- AlterTable
ALTER TABLE "Message" ADD COLUMN "mentions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
