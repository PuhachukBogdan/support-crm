-- Feature 028 (real email delivery) — the outbox.
--
-- Purely ADDITIVE: one new table. Nothing that already exists gains a column or loses a
-- constraint, and no backfill is needed — the table is empty until the first message is produced.
--
-- ⚠️ The row holds a LIVE SECRET (the clear login code, or the invite token) in `payload_json`
-- until it is delivered. That is deliberate and bounded: the row is DELETED on success rather than
-- marked, `expires_at` makes an undeliverable row worthless within minutes, and it lives in the
-- same database that already holds the code's argon2 hash. Rendering the full body at write time
-- would store the same secret and more of it; there is no variant where nothing is at rest.

CREATE TABLE "OutboundEmail" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- A CLASS, never the relay's own text: SMTP rejections quote the envelope, and the envelope
    -- carries the recipient (Principle IV).
    "last_error_class" TEXT,
    "last_attempt_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundEmail_pkey" PRIMARY KEY ("id")
);

-- The claim query: "the oldest rows that still need sending". Leading with `status` because the
-- sweep always filters on it and only then orders.
CREATE INDEX "OutboundEmail_status_created_at_idx" ON "OutboundEmail"("status", "created_at");

-- "What did we try to send this person?" — the question asked while someone is on the phone
-- saying no code arrived.
CREATE INDEX "OutboundEmail_to_email_idx" ON "OutboundEmail"("to_email");

CREATE INDEX "OutboundEmail_account_id_idx" ON "OutboundEmail"("account_id");
