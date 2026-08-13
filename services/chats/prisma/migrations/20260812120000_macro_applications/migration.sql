-- W29 (R46): one row per macro application — the weekly usage counter's raw fact.
CREATE TABLE "MacroApplication" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "macro_id" TEXT NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MacroApplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MacroApplication_account_id_macro_id_applied_at_idx"
  ON "MacroApplication"("account_id", "macro_id", "applied_at");
