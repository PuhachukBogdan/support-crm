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
    for (const conv of seed.conversations) {
      /**
       * ⚠️ **The contact stamps are written on CREATE only, never on UPDATE — found by Track B.**
       *
       * `last_inbound_at` / `last_outbound_at` are **maintained data**, produced by the message write
       * (feature 022), not fixture configuration. The first live run exposed what a plain `update: conv`
       * does on a host with history: `seed-conv-open` had accumulated three public replies from earlier
       * features' Track-B runs, the migration's backfill had correctly stamped it `2026-07-26 16:11`, and
       * re-seeding **reset it to 09:15** — the value derived from the fixture messages alone. The row then
       * disagreed with its own messages, and Track A could not see it: its fixtures ARE the whole history.
       *
       * A fixture may declare a starting state. It may not overwrite data the product maintains and it did
       * not produce. So a fresh host gets the derived values through `create`, and an existing row keeps
       * whatever the message path has since maintained.
       */
      const { last_inbound_at, last_outbound_at, ...withoutStamps } = conv;
      void last_inbound_at;
      void last_outbound_at;
      await db.conversation.upsert({
        where: { id: conv.id },
        create: conv,
        update: withoutStamps,
      });
    }
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
