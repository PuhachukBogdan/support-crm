-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandAccessRule" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "access_level" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandAccessRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Brand_account_id_idx" ON "Brand"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_account_id_slug_key" ON "Brand"("account_id", "slug");

-- CreateIndex
CREATE INDEX "BrandAccessRule_account_id_brand_id_idx" ON "BrandAccessRule"("account_id", "brand_id");

-- CreateIndex
CREATE INDEX "BrandAccessRule_operator_id_idx" ON "BrandAccessRule"("operator_id");

-- AddForeignKey
ALTER TABLE "BrandAccessRule" ADD CONSTRAINT "BrandAccessRule_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

