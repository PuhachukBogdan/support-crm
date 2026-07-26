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
    // feature 013 (roadmap 4.5): macro definitions + the canned-response library.
    for (const macro of seed.macros)
      await db.macro.upsert({
        where: { id: macro.id },
        create: macro as never,
        update: macro as never,
      });
    for (const canned of seed.cannedResponses)
      await db.cannedResponse.upsert({
        where: { id: canned.id },
        create: canned,
        update: canned,
      });
    // feature 014 (roadmap 4.6/4.7): automation rules + the first-reply SLA target.
    //
    // Rule state is reset on every seed run (`update` carries `active` and the definition), which is
    // deliberate: the Track-B script enables/disables individual rules, and a leftover enabled rule
    // from a previous run reads as a product defect (the 013 harness lesson).
    for (const rule of seed.automations)
      await db.automation.upsert({
        where: { id: rule.id },
        create: rule as never,
        update: rule as never,
      });
    for (const policy of seed.slaPolicies)
      await db.firstReplySlaPolicy.upsert({
        where: { id: policy.id },
        create: policy,
        update: policy,
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
