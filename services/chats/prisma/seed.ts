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
    /**
     * ⭐ Feature 032 (roadmap 4.16) — FIRST, before any conversation.
     *
     * `Conversation.status` holds a composite foreign key into this table, so a ticket cannot be written
     * until the vocabulary it names exists. Keyed on `(account_id, key)` rather than on `id`: the key IS
     * the identity within an account, and re-running must leave nine statuses rather than eighteen.
     *
     * ⚠️ `update` deliberately carries the NAMES and the order but NOT `active`. Retiring a status is an
     * operator's decision (the authoring screen, roadmap 3.14), and a re-seed that switched it back on
     * would undo that silently — the same rule the contact stamps below follow, one table over: a fixture
     * may declare a starting state and may not overwrite what a person has since decided.
     */
    for (const st of seed.statuses)
      await db.conversationStatus.upsert({
        where: { account_id_key: { account_id: st.account_id, key: st.key } },
        create: st,
        update: {
          category: st.category,
          agent_name: st.agent_name,
          end_user_name: st.end_user_name,
          order: st.order,
        },
      });
    /**
     * ⭐ Feature 033 (roadmap 6.5, subpoint 2.1h) — the configured channels.
     *
     * Keyed on `(account_id, key)` for the same reason the statuses above are: the key is the identity a
     * delivery names, and a re-seed must leave one channel rather than two competing for the same inbound
     * mail — which the `(account_id, brand_id, kind)` unique would refuse anyway, loudly.
     *
     * ⚠️ `update` deliberately omits `enabled`. Disabling a channel is the operator's stop button before
     * the admin screen exists (roadmap 3.10 / W15), and a re-seed that switched a retired key back on would
     * silently undo the one act available to somebody trying to stop a misbehaving integration. Same rule
     * the statuses follow one block above: a fixture may declare a starting state and may not overwrite
     * what a person has since decided.
     *
     * ⓘ `default_group_id` IS in the update, unlike `enabled` — deliberately. W5 introduces the column,
     * so every stand this seed has ever run on holds channels with NULL there, and omitting it would
     * leave routing dead on precisely the databases the live run uses. The moment W15 gives a human a
     * screen to set it, this line moves up into the `enabled` rule — a decision recorded there.
     */
    for (const ch of seed.channels)
      await db.channel.upsert({
        where: { account_id_key: { account_id: ch.account_id, key: ch.key } },
        create: ch,
        update: {
          brand_id: ch.brand_id,
          kind: ch.kind,
          address: ch.address,
          default_group_id: ch.default_group_id,
        },
      });
    for (const label of seed.labels)
      await db.label.upsert({ where: { id: label.id }, create: label, update: label });
    /**
     * ⭐ Feature 037 (roadmap 4.15 — W30) — sets → values → fields → forms → entries, in FK order.
     *
     * ⚠️ Field/form `update` deliberately carries the LABELS and structure but NOT `active`, and
     * option-value `update` NOT `active` either: archiving a field and deactivating a value are the
     * operator's decisions on the /admin/fields screen, and a re-seed must not switch them back on
     * (the statuses rule, third instance). Entries ARE reset wholesale — they are the fixture's
     * structure, and the screen edits them atomically anyway.
     */
    for (const set of seed.optionSets)
      await db.optionSet.upsert({
        where: { id: set.id },
        create: set,
        update: { name: set.name },
      });
    for (const val of seed.optionValues)
      await db.optionValue.upsert({
        where: { id: val.id },
        create: val,
        update: { value: val.value, order: val.order },
      });
    for (const field of seed.fieldDefinitions)
      await db.fieldDefinition.upsert({
        where: { account_id_key: { account_id: field.account_id, key: field.key } },
        create: field,
        update: {
          label: field.label,
          required: field.required,
          restricted: field.restricted,
          option_set_id: field.option_set_id,
          brand_ids: field.brand_ids,
        },
      });
    for (const form of seed.forms)
      await db.form.upsert({
        where: { account_id_key: { account_id: form.account_id, key: form.key } },
        create: form,
        update: { name: form.name, category: form.category, order: form.order },
      });
    for (const entry of seed.formFields)
      await db.formField.upsert({
        where: { form_id_field_id: { form_id: entry.form_id, field_id: entry.field_id } },
        create: entry,
        update: {
          order: entry.order,
          condition_field_id: entry.condition_field_id,
          condition_value: entry.condition_value,
          is_subcategory_source: entry.is_subcategory_source,
        },
      });
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
