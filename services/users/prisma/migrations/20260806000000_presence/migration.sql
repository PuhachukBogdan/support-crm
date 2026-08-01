-- Feature 025 — agent presence, for routing only (roadmap 5.9, ADR 0042 §7 / U4).
--
-- Hand-written, like every migration in this repository, and therefore able to drift from
-- schema.prisma. `tests/data-model/group-grant-is-positive-only.spec.ts` established the habit of
-- asserting the SQL as well as the schema; the presence equivalent does the same.

-- ── Presence: one row per person, keyed on the AUTH identity ─────────────────────────────────────
-- Not on Operator.id: group membership keys on the auth identity, every actor reference in the
-- transition stream is an auth user id, and feature 024 flagged Conversation.assignee_operator_id as
-- the one outlier nothing validates (research R3).
--
-- NOTE the absence of an `available` column. Availability is DERIVED, and there are two kinds of ask
-- (a new push versus a human transfer) which `transfers_only` answers differently — one stored
-- boolean could not be correct for both.
CREATE TABLE "OperatorPresence" (
    "account_id"   TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "state"        TEXT NOT NULL,
    -- manual | auto_inactivity | admin. NULL = never set, which is a state a first heartbeat may
    -- raise from. FR-016 cannot be enforced without this column: the history says what happened,
    -- this says what is true now.
    "last_cause"   TEXT,
    "last_seen_at" TIMESTAMP(3),
    "label_id"     TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorPresence_pkey" PRIMARY KEY ("account_id","auth_user_id")
);

-- The sweep's only query: "who has been quiet longer than the threshold?"
CREATE INDEX "OperatorPresence_account_id_last_seen_at_idx"
    ON "OperatorPresence"("account_id", "last_seen_at");

-- ── Channel blocks: a row exists ONLY for a channel switched OFF ─────────────────────────────────
-- There is deliberately no `available` column: a row's existence IS the block, and switching a
-- channel back on deletes the row. A channel switch may only ever SUBTRACT availability, and the
-- column that could express the violation does not exist — the mirror image of "GroupPermission"
-- having no "granted" column in auth_db.
CREATE TABLE "OperatorChannelBlock" (
    "account_id"   TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "channel"      TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorChannelBlock_pkey" PRIMARY KEY ("account_id","auth_user_id","channel")
);

-- ── Labels: administrator-editable decoration, never a routing input ─────────────────────────────
CREATE TABLE "PresenceLabel" (
    "id"         TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "state"      TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresenceLabel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PresenceLabel_account_id_name_key" ON "PresenceLabel"("account_id", "name");
CREATE INDEX "PresenceLabel_account_id_idx" ON "PresenceLabel"("account_id");

-- ── The second writer of the durable transition stream ───────────────────────────────────────────
-- Column-for-column identical to chats."ConversationTransition". A separate TABLE because a shared
-- cross-service table would break database-per-service; one logical stream is achieved downstream in
-- the B2 aggregate store, not here.
--
-- Append-only: no UPDATE and no DELETE path exists in any service.
CREATE TABLE "OperatorTransition" (
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

    CONSTRAINT "OperatorTransition_pkey" PRIMARY KEY ("id")
);

-- The aggregator's watermark. "id" breaks same-millisecond ties so paging stays deterministic.
CREATE INDEX "OperatorTransition_account_id_occurred_at_id_idx"
    ON "OperatorTransition"("account_id", "occurred_at", "id");
CREATE INDEX "OperatorTransition_account_id_subject_id_occurred_at_idx"
    ON "OperatorTransition"("account_id", "subject_id", "occurred_at");
CREATE INDEX "OperatorTransition_account_id_type_occurred_at_idx"
    ON "OperatorTransition"("account_id", "type", "occurred_at");
