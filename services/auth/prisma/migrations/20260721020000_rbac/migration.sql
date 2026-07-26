-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "introduced_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "UserPermissionSet" (
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'inherited',
    "snapshot_role_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPermissionSet_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "UserPermissionEntry" (
    "user_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "UserPermissionEntry_pkey" PRIMARY KEY ("user_id","permission_id")
);

-- CreateTable
CREATE TABLE "PrivilegeAudit" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_ref" TEXT NOT NULL,
    "detail_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivilegeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Permission_account_id_idx" ON "Permission"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_account_id_category_key_key" ON "Permission"("account_id", "category", "key");

-- CreateIndex
CREATE INDEX "RolePermission_permission_id_idx" ON "RolePermission"("permission_id");

-- CreateIndex
CREATE INDEX "UserPermissionSet_account_id_idx" ON "UserPermissionSet"("account_id");

-- CreateIndex
CREATE INDEX "UserPermissionEntry_user_id_idx" ON "UserPermissionEntry"("user_id");

-- CreateIndex
CREATE INDEX "PrivilegeAudit_account_id_created_at_idx" ON "PrivilegeAudit"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionSet" ADD CONSTRAINT "UserPermissionSet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionEntry" ADD CONSTRAINT "UserPermissionEntry_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPermissionEntry" ADD CONSTRAINT "UserPermissionEntry_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

