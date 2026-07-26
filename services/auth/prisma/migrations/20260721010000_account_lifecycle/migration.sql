-- CreateTable
CREATE TABLE "SuperadminWhitelist" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperadminWhitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role_key" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SuperadminWhitelist_email_key" ON "SuperadminWhitelist"("email");

-- CreateIndex
CREATE INDEX "SuperadminWhitelist_account_id_idx" ON "SuperadminWhitelist"("account_id");

-- CreateIndex
CREATE INDEX "Invitation_account_id_idx" ON "Invitation"("account_id");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- CreateIndex
CREATE INDEX "Invitation_expires_at_idx" ON "Invitation"("expires_at");

