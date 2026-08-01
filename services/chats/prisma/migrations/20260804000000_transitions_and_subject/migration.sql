-- Feature 023 (roadmap 4.8a + 4.18) — the append-only transition stream, and the conversation's title.
--
-- ONE migration for two capabilities, because they are one table change plus two columns on a table the
-- same feature already opens. Splitting them would mean two migrations over the same hot table.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- PART A — ConversationTransition (roadmap 4.8a, ADR 0046)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHY IT EXISTS AND WHY IT COULD NOT WAIT. Every metric this support team lives by — backlog, reopened
-- %, one-touch %, first reply time, per-agent load — is derived from TRANSITIONS, not from a
-- conversation's current row. Store only current state and those numbers are permanently unavailable
-- for the past: no later migration can invent a transition that was never recorded. It has not bitten
-- yet only because Principle V means no real data exists; that ends at the Zendesk migration (14.3).
--
-- ⚠️ THIS IS NOT THE AUDIT TRAIL AND NOT A DomainEvent. `AuditEntry` (015) is STRICT — a failed write
-- refuses the action — and PII is inexpressible there. `DomainEvent` (014, src/events/) is in-process,
-- synchronous, deliberately LOSSY, and legitimately carries message text in memory. Three different
-- things; merging this with the third would put customer message bodies into an append-only store.
--
-- NO `delivered_at` COLUMN, deliberately. The consumer (the aggregation store, roadmap 11.0) does not
-- exist, so there is nothing to mark. A later aggregator reads forward by WATERMARK over
-- (account_id, occurred_at, id) — an index this table needs for ordering anyway. An inert status
-- column on the largest table in the product is the shape ADR 0038 removed.
--
-- occurred_at vs created_at: occurred_at is when it HAPPENED and is the ordering key; created_at is
-- when the row was written. They differ only under retry, and conflating them would make a replayed
-- write look like a later event.
CREATE TABLE "ConversationTransition" (
  "id"             TEXT NOT NULL,
  "account_id"     TEXT NOT NULL,
  "type"           TEXT NOT NULL,
  "occurred_at"    TIMESTAMP(3) NOT NULL,
  "actor_kind"     TEXT NOT NULL,
  "actor_ref"      TEXT,
  "subject_kind"   TEXT NOT NULL,
  "subject_id"     TEXT NOT NULL,
  "payload_json"   JSONB,
  "dims_json"      JSONB NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationTransition_pkey" PRIMARY KEY ("id")
);

-- Ordering, and the watermark a later aggregator reads forward on. `id` is in the index so two
-- transitions in the same millisecond still page deterministically — the lesson feature 015 paid for.
CREATE INDEX "ConversationTransition_account_id_occurred_at_id_idx"
  ON "ConversationTransition" ("account_id", "occurred_at", "id");

-- "Reconstruct this conversation's life" (SC-001).
CREATE INDEX "ConversationTransition_account_id_subject_id_occurred_at_idx"
  ON "ConversationTransition" ("account_id", "subject_id", "occurred_at");

-- "Every status change in this range" (SC-002).
CREATE INDEX "ConversationTransition_account_id_type_occurred_at_idx"
  ON "ConversationTransition" ("account_id", "type", "occurred_at");

-- NO BACKFILL, and that is a decision rather than an omission. Feature 022's migration backfilled its
-- columns because a NULL there would have made the card report "never contacted" for all history — a
-- wrong ANSWER. Here the honest answer is that no transition was recorded, because none was: inventing
-- one would fabricate a history that did not happen, which is the opposite of what this table is for.
-- The ~372K tickets arriving at roadmap 14.3 must decide explicitly what they can and cannot
-- reconstruct; this migration deliberately does not decide it for them.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- PART B — the conversation's title (roadmap 4.18, R10/U8/U9)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
--
-- Their chat subjects are the first message taken literally, so lists read as "привет", "???" and
-- mid-word fragments. The title is derived from the customer's first SUBSTANTIVE words and then FROZEN.
--
-- `subject_source` is what makes the freeze enforceable rather than conventional: `manual` means a
-- human wrote it and no automated writer may touch it again, ever. NULL means the window is still open,
-- which is distinct from "set to nothing" — hence nullable rather than defaulted.
--
-- NO INDEX ON `subject`, deliberately: search must never depend on the subject (R10/U19). It is
-- model-generated and human-editable, so building navigation on it means building navigation on a
-- mutable, occasionally wrong string. Filtering runs on message content, labels, category and player
-- identifiers.
--
-- NO BACKFILL either: deriving titles for existing rows would run the derivation over history the
-- feature has never seen, and every existing row here is synthetic anyway.
ALTER TABLE "Conversation"
  ADD COLUMN "subject"        TEXT,
  ADD COLUMN "subject_source" TEXT;

-- …but an index on the WINDOW, which is a different thing from an index on the title.
--
-- The 10-minute timeout is closed by a sweep (research R5: one indexed query per tick, not ~3 000
-- delayed jobs a day), and its predicate is exactly `subject_source IS NULL AND created_at <= …`.
-- Without this the sweep is a sequential scan over every conversation ever created, once a minute,
-- forever — and it gets slower for the rest of the product's life.
--
-- A PARTIAL index (`WHERE subject_source IS NULL`) would be smaller still and is what this wants;
-- Prisma 6 cannot express one, so the schema declares the plain composite and this file matches it.
-- Making them differ to gain a partial index would leave `prisma migrate diff` permanently dirty,
-- which is a worse trade than the extra pages: the open-window set is minutes old and tiny, so the
-- entries that matter sit together at one end of the btree either way.
CREATE INDEX "Conversation_subject_source_created_at_idx"
  ON "Conversation" ("subject_source", "created_at");
