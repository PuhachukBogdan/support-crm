-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "player_id" TEXT,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT,
    "channel" TEXT,
    "assignee_operator_id" TEXT,
    "category" TEXT,
    "sub_category" TEXT,
    "classified_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "author_type" TEXT NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Label" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationLabel" (
    "conversation_id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,

    CONSTRAINT "ConversationLabel_pkey" PRIMARY KEY ("conversation_id","label_id")
);

-- CreateTable
CREATE TABLE "Macro" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Macro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_account_id_status_idx" ON "Conversation"("account_id", "status");

-- CreateIndex
CREATE INDEX "Conversation_account_id_player_id_idx" ON "Conversation"("account_id", "player_id");

-- CreateIndex
CREATE INDEX "Conversation_brand_id_idx" ON "Conversation"("brand_id");

-- CreateIndex
CREATE INDEX "Conversation_player_id_idx" ON "Conversation"("player_id");

-- CreateIndex
CREATE INDEX "Message_conversation_id_created_at_idx" ON "Message"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "Message_account_id_idx" ON "Message"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "Label_account_id_name_key" ON "Label"("account_id", "name");

-- CreateIndex
CREATE INDEX "ConversationLabel_label_id_idx" ON "ConversationLabel"("label_id");

-- CreateIndex
CREATE INDEX "Macro_account_id_idx" ON "Macro"("account_id");

-- CreateIndex
CREATE INDEX "Automation_account_id_idx" ON "Automation"("account_id");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLabel" ADD CONSTRAINT "ConversationLabel_label_id_fkey" FOREIGN KEY ("label_id") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

