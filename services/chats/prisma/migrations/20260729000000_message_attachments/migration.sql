-- Feature 016 (roadmap 4.9): a message's link to an upload.
--
-- Additive: a new table hanging off `Message`, nothing reshaped. `upload_id` is a SOFT reference to
-- `users.Upload.id` — there is no foreign key here and there cannot be one, because the two tables
-- live in different databases (Principle VIII). The reference is validated over gRPC BEFORE the
-- message is written (research R8), which is where the account boundary is actually enforced.
--
-- The unique on (message_id, upload_id) IS the "attached twice" guarantee. An application-level
-- "have I already attached this?" followed by a write is a race; a unique index is not — the same
-- reasoning feature 014 used for at-most-once rule application.
--
-- The FK on message_id cascades: deleting a message takes its attachment rows with it. That removes
-- the LINK, never the bytes — nothing in v1 deletes an object, and a future attachment-delete path
-- is its own feature (it also has to decide what a `deletion` audit entry looks like for a file).
--
-- Applied on Track B with:
--   prisma migrate deploy --schema services/chats/prisma/schema.prisma

-- CreateTable
CREATE TABLE "MessageAttachment" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "upload_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAttachment_account_id_idx" ON "MessageAttachment"("account_id");

-- CreateIndex
CREATE INDEX "MessageAttachment_message_id_position_idx" ON "MessageAttachment"("message_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAttachment_message_id_upload_id_key" ON "MessageAttachment"("message_id", "upload_id");

-- AddForeignKey
ALTER TABLE "MessageAttachment" ADD CONSTRAINT "MessageAttachment_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
