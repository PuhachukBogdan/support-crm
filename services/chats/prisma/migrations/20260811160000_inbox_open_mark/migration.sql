-- MVP block W25 (R23 / roadmap 9.12) — the unread badge's one fact.
--
-- "This operator last OPENED the Inbox at". The counter the operator specified is DERIVED from it
-- (conversations in my Inbox slice with created_at > opened_at), never accumulated client-side —
-- which is what makes the badge survive a reload from server state (9.12's Done-when).
-- No backfill: an operator with no row has never opened the Inbox, and everything in their slice
-- is honestly unseen.

CREATE TABLE "InboxOpenMark" (
    "account_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxOpenMark_pkey" PRIMARY KEY ("account_id", "operator_id")
);
