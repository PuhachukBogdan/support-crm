-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "display_name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "custom_attributes" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Player" (
    "player_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "vip" BOOLEAN NOT NULL DEFAULT false,
    "segment" TEXT,
    "am_notes" TEXT,
    "preferences" JSONB,
    "portfolio" JSONB,
    "custom_attributes" JSONB,
    "gr8_snapshot" JSONB,
    "gr8_fetched_at" TIMESTAMP(3),
    "gr8_stale" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("player_id")
);

-- CreateTable
CREATE TABLE "PlayerBrand" (
    "player_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,

    CONSTRAINT "PlayerBrand_pkey" PRIMARY KEY ("player_id","brand_id")
);

-- CreateIndex
CREATE INDEX "Operator_account_id_idx" ON "Operator"("account_id");

-- CreateIndex
CREATE INDEX "Player_account_id_idx" ON "Player"("account_id");

-- CreateIndex
CREATE INDEX "Player_account_id_vip_idx" ON "Player"("account_id", "vip");

-- CreateIndex
CREATE INDEX "Player_account_id_segment_idx" ON "Player"("account_id", "segment");

-- CreateIndex
CREATE INDEX "PlayerBrand_brand_id_idx" ON "PlayerBrand"("brand_id");

-- AddForeignKey
ALTER TABLE "PlayerBrand" ADD CONSTRAINT "PlayerBrand_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "Player"("player_id") ON DELETE CASCADE ON UPDATE CASCADE;

