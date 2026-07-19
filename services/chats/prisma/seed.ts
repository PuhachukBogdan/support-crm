import { withAccountScope, SEED_ACCOUNT_ID } from '@crm/common';
import { PrismaClient } from '../src/generated/prisma';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { buildSeed } from './seed.build';

/**
 * chats_db seed runner (feature 008). Account-scoped writes (feature 007); idempotent upserts.
 * Run: `DATABASE_URL=<chats_db url> npm run seed:chats` (live on beton-test — Track B).
 */
async function run(): Promise<void> {
  const base = new PrismaClient();
  const db = withAccountScope(base, SEED_ACCOUNT_ID, { scopedModels: SCOPED_MODELS });
  const seed = buildSeed();
  try {
    for (const label of seed.labels)
      await db.label.upsert({ where: { id: label.id }, create: label, update: label });
    for (const conv of seed.conversations)
      await db.conversation.upsert({ where: { id: conv.id }, create: conv, update: conv });
    for (const msg of seed.messages)
      await db.message.upsert({ where: { id: msg.id }, create: msg, update: msg });
    for (const cl of seed.conversationLabels)
      await db.conversationLabel.upsert({
        where: { conversation_id_label_id: { conversation_id: cl.conversation_id, label_id: cl.label_id } },
        create: cl,
        update: {},
      });
    console.log('chats seed: ok');
  } finally {
    await base.$disconnect();
  }
}

run().catch((err) => {
  console.error('chats seed failed:', err);
  process.exit(1);
});
