-- ⭐ W19 (subpoint 5.4, roadmap 8.10): the operator's avatar as an UPLOAD REFERENCE.
-- A soft ref to Upload.id (purpose `avatar`) — never bytes, never a URL. Nullable: no avatar is the
-- ordinary starting state, and the column adds no constraint a backfill would have to satisfy.
ALTER TABLE "Operator" ADD COLUMN "avatar_upload_id" TEXT;
