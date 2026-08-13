-- Feature 037 (roadmap 4.15 — W30): custom ticket fields, forms & option sets.
-- Additive throughout: five new tables, one nullable column on Conversation, no backfill —
-- NULL form_key is the correct value for every existing row (unfiled, like the classification
-- columns beside it).

CREATE TABLE "OptionSet" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OptionSet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OptionSet_account_id_name_key" ON "OptionSet"("account_id", "name");
CREATE INDEX "OptionSet_account_id_idx" ON "OptionSet"("account_id");

CREATE TABLE "OptionValue" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "option_set_id" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "OptionValue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OptionValue_option_set_id_fkey" FOREIGN KEY ("option_set_id")
    REFERENCES "OptionSet"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "OptionValue_option_set_id_value_key" ON "OptionValue"("option_set_id", "value");
CREATE INDEX "OptionValue_option_set_id_order_idx" ON "OptionValue"("option_set_id", "order");
CREATE INDEX "OptionValue_account_id_idx" ON "OptionValue"("account_id");

CREATE TABLE "FieldDefinition" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "restricted" BOOLEAN NOT NULL DEFAULT false,
  "option_set_id" TEXT,
  "brand_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FieldDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FieldDefinition_option_set_id_fkey" FOREIGN KEY ("option_set_id")
    REFERENCES "OptionSet"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FieldDefinition_account_id_key_key" ON "FieldDefinition"("account_id", "key");
CREATE INDEX "FieldDefinition_account_id_active_idx" ON "FieldDefinition"("account_id", "active");
CREATE INDEX "FieldDefinition_option_set_id_idx" ON "FieldDefinition"("option_set_id");

CREATE TABLE "Form" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Form_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Form_account_id_key_key" ON "Form"("account_id", "key");
CREATE UNIQUE INDEX "Form_account_id_name_key" ON "Form"("account_id", "name");
CREATE INDEX "Form_account_id_active_order_idx" ON "Form"("account_id", "active", "order");

CREATE TABLE "FormField" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "form_id" TEXT NOT NULL,
  "field_id" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "condition_field_id" TEXT,
  "condition_value" TEXT,
  "is_subcategory_source" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "FormField_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FormField_form_id_fkey" FOREIGN KEY ("form_id")
    REFERENCES "Form"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FormField_field_id_fkey" FOREIGN KEY ("field_id")
    REFERENCES "FieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "FormField_form_id_field_id_key" ON "FormField"("form_id", "field_id");
CREATE INDEX "FormField_form_id_order_idx" ON "FormField"("form_id", "order");
CREATE INDEX "FormField_account_id_idx" ON "FormField"("account_id");

-- ⭐ At most ONE sub-category source per form (spec FR-005). Prisma cannot express a conditional
-- unique, so the constraint lives HERE — the feature-026 partial-unique precedent — and
-- `tests/fields/` reads this SQL rather than trusting the schema comment.
CREATE UNIQUE INDEX "FormField_one_subcategory_source_per_form"
  ON "FormField"("form_id")
  WHERE "is_subcategory_source";

CREATE TABLE "ConversationFieldValue" (
  "id" TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "field_id" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConversationFieldValue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConversationFieldValue_conversation_id_fkey" FOREIGN KEY ("conversation_id")
    REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConversationFieldValue_field_id_fkey" FOREIGN KEY ("field_id")
    REFERENCES "FieldDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConversationFieldValue_conversation_id_field_id_key"
  ON "ConversationFieldValue"("conversation_id", "field_id");
CREATE INDEX "ConversationFieldValue_field_id_idx" ON "ConversationFieldValue"("field_id");
CREATE INDEX "ConversationFieldValue_account_id_idx" ON "ConversationFieldValue"("account_id");

-- The form choice on the conversation — nullable, no backfill, the status_def composite shape.
-- Deliberately UNINDEXED (research D13): no list filters by form this block.
ALTER TABLE "Conversation" ADD COLUMN "form_key" TEXT;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_account_id_form_key_fkey"
  FOREIGN KEY ("account_id", "form_key") REFERENCES "Form"("account_id", "key")
  ON DELETE RESTRICT ON UPDATE CASCADE;
