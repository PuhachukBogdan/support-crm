-- ⭐ W31 / feature 038 (roadmap 3.15/3.17, ADR 0043): the staff-provisioning machine path.
-- Additive: three new tables, no change to any existing one. Nothing is backfilled — an account
-- with no key simply has no machine path, which is the correct starting state.

CREATE TABLE "ApiKey" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "consumer" TEXT NOT NULL,
  "secret_hash" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  -- ⚠️ Empty DENIES (fail-closed). The default is an empty array rather than NULL so the deny is a
  -- property of the value, not of a nullability check somebody might forget.
  "ip_allow_list" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "rate_per_hour" INTEGER NOT NULL DEFAULT 60,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "rotated_from_id" TEXT,
  "last_used_at" TIMESTAMP(3),
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApiKey_account_id_active_idx" ON "ApiKey"("account_id", "active");
CREATE INDEX "ApiKey_account_id_consumer_idx" ON "ApiKey"("account_id", "consumer");

-- ⭐ ONE ACTIVE KEY PER CONSUMER, as a partial unique index — Prisma cannot express the filter, so
-- the constraint lives here and `tests/provisioning/` reads this SQL rather than trusting a comment
-- (the feature-026 precedent, third instance). Rotation revokes before it issues, so the pair never
-- collides; two live keys for one consumer would make «revoke the HR key» ambiguous at the worst
-- possible moment.
CREATE UNIQUE INDEX "ApiKey_one_active_per_consumer"
  ON "ApiKey"("account_id", "consumer")
  WHERE "active";

CREATE TABLE "ProvisioningRequest" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "api_key_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "status_code" INTEGER NOT NULL,
  "response_json" JSONB NOT NULL,
  "outcome" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProvisioningRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProvisioningRequest_api_key_id_fkey" FOREIGN KEY ("api_key_id")
    REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The claim: a retry loses this race and reads the winner's stored answer.
CREATE UNIQUE INDEX "ProvisioningRequest_api_key_id_idempotency_key_key"
  ON "ProvisioningRequest"("api_key_id", "idempotency_key");
CREATE INDEX "ProvisioningRequest_account_id_created_at_idx"
  ON "ProvisioningRequest"("account_id", "created_at");

CREATE TABLE "StaffIdentity" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "hr_employee_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffIdentity_pkey" PRIMARY KEY ("id")
);
-- One human, one HR id, one account. Both directions are unique: a second row for either side is
-- the duplicate-identity failure ADR 0043 §7 exists to prevent.
CREATE UNIQUE INDEX "StaffIdentity_account_id_hr_employee_id_key"
  ON "StaffIdentity"("account_id", "hr_employee_id");
CREATE UNIQUE INDEX "StaffIdentity_account_id_user_id_key"
  ON "StaffIdentity"("account_id", "user_id");
CREATE INDEX "StaffIdentity_account_id_idx" ON "StaffIdentity"("account_id");
