import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  SEED_PLAYER_ID,
  SEED_OPERATOR_ID,
  SEED_LABEL_ID,
  SEED_CONVERSATION_OPEN_ID,
  SEED_CONVERSATION_RESOLVED_ID,
  SEED_CONVERSATION_PENDING_ID,
  SEED_CONVERSATION_BRAND2_ID,
  SEED_CONVERSATION_UNASSIGNED_ID,
  SEED_LABEL_ID_2,
  SEED_MACRO_ID,
  SEED_MACRO_ASSIGN_ID,
  SEED_CANNED_RESPONSE_ID,
  SEED_MESSAGE_PLAYER_ID,
  SEED_MESSAGE_REPLY_ID,
  SEED_MESSAGE_NOTE_ID,
  // Feature 029 (FR-024) — the three category conversations for judging the Inbox.
  SEED_CONVERSATION_TEST_ID,
  SEED_CONVERSATION_BILLING_ID,
  SEED_CONVERSATION_ACCESS_ID,
  SEED_MESSAGE_TEST_1_ID,
  SEED_MESSAGE_TEST_2_ID,
  SEED_MESSAGE_TEST_3_ID,
  SEED_MESSAGE_TEST_4_ID,
  SEED_MESSAGE_BILLING_ID,
  SEED_MESSAGE_ACCESS_ID,
  // feature 014 (roadmap 4.6/4.7).
  SEED_AUTOMATION_KEYWORD_ID,
  SEED_AUTOMATION_ASSIGN_ID,
  SEED_AUTOMATION_SELF_ID,
  SEED_AUTOMATION_BREACH_ID,
  SEED_AUTOMATION_KEYWORD,
  SEED_SLA_POLICY_ID,
  SEED_SLA_TARGET_MINUTES,
  SEED_CONVERSATION_SLA_ID,
  SEED_AUTH_USER_ID,
  // feature 022 (roadmap 4.13): the contact-history fixtures — a system entry, a recorded channel, and the
  // explicitly linked cross-brand person.
  SEED_MESSAGE_SYSTEM_ID,
  SEED_CONVERSATION_LINKED_A_ID,
  SEED_CONVERSATION_LINKED_B_ID,
  SEED_MESSAGE_LINKED_A_ID,
  SEED_MESSAGE_LINKED_B_ID,
  SEED_MESSAGE_LINKED_B_REPLY_ID,
  SEED_PLAYER_LINKED_A,
  SEED_PLAYER_LINKED_B,
  SEED_CHANNEL_EMAIL,
  SEED_CHANNEL_API,
  // Feature 033 (roadmap 6.5, 2.1h): the two configured channels. The KEY must also appear in the
  // deployment's `CHANNEL_SECRETS` — the row holds no secret and cannot.
  SEED_CHANNEL_API_ID,
  SEED_CHANNEL_EMAIL_ID,
  SEED_CHANNEL_API_KEY,
  SEED_CHANNEL_EMAIL_KEY,
  SEED_CHANNEL_EMAIL_ADDRESS,
  // W5 (subpoint 2.4): the desk both channels push to — the same constant auth seeds as routable.
  SEED_GROUP_A_ID,
  // Feature 032 (roadmap 4.16): the nine configured statuses — the SAME constant the SQL migration's
  // backfill is written from, so a fresh database and a migrated one cannot disagree.
  SEEDED_STATUSES,
} from '@crm/common';
// Feature 022 (roadmap 4.13): the seed derives its contact stamps with the PRODUCTION rule. Importing it
// is the point — a copy here would be a third statement of the same fact (after the code and the
// migration's SQL), and the copies would drift silently.
import { decideContactStamp } from '../src/message/contact-stamp';

/**
 * Pure synthetic dataset for chats_db (feature 008). No I/O — unit-testable (Track A). Exercises the
 * reserved classification fields (ADR 0027) + the player_id feed key + a private (internal) note.
 * brand_id / player_id / assignee_operator_id are soft refs (resolved via gRPC, never joined).
 */
/**
 * Fixed message timestamps (feature 022). Explicit rather than `now()` at seed time, for two reasons:
 * the derived contact stamps below must equal the messages they come from, and Track B compares a value
 * read from Postgres against the same value from the API — a moving fixture makes that comparison a
 * coin toss.
 */
export const SEED_MESSAGE_PLAYER_AT = new Date('2026-07-20T09:00:00.000Z');
export const SEED_MESSAGE_REPLY_AT = new Date('2026-07-20T09:15:00.000Z');
/** LATER than the public reply on purpose: a private note must not become the last outbound contact. */
export const SEED_MESSAGE_NOTE_AT = new Date('2026-07-20T09:30:00.000Z');
/** LATER than everything else on that conversation: a system entry must not become contact either. */
export const SEED_MESSAGE_SYSTEM_AT = new Date('2026-07-20T09:45:00.000Z');

/**
 * Feature 029 (FR-024) — the three category conversations the operator asked for.
 *
 * Spread across three days so the Inbox's two orders have something visibly different to do with
 * them: newest-updated first and oldest-updated first must not look like the same list.
 */
export const SEED_MESSAGE_CAT_TEST_AT = new Date('2026-07-30T11:00:00.000Z');
export const SEED_MESSAGE_CAT_TEST_2_AT = new Date('2026-07-30T11:04:00.000Z');
export const SEED_MESSAGE_CAT_TEST_3_AT = new Date('2026-07-30T11:09:00.000Z');
export const SEED_MESSAGE_CAT_TEST_4_AT = new Date('2026-07-30T11:12:00.000Z');
export const SEED_MESSAGE_CAT_BILLING_AT = new Date('2026-07-28T14:20:00.000Z');
export const SEED_MESSAGE_CAT_ACCESS_AT = new Date('2026-07-27T08:05:00.000Z');

/** The linked person's contact — the second brand is LATER, so the person-level maximum comes from it. */
export const SEED_MESSAGE_LINKED_A_AT = new Date('2026-07-23T10:00:00.000Z');
export const SEED_MESSAGE_LINKED_B_AT = new Date('2026-07-24T10:00:00.000Z');
export const SEED_MESSAGE_LINKED_B_REPLY_AT = new Date('2026-07-24T10:30:00.000Z');

/**
 * Derive each conversation's contact stamps from its own messages, using the PRODUCTION rule
 * (`decideContactStamp`) — never a copy of it.
 *
 * ── Why the seed has to do this at all (research R3) ─────────────────────────────────────────────
 * `seed.ts` writes messages with `message.upsert`, bypassing `MessageRepository.post` — the one place
 * that maintains the stamps. So seeded conversations would carry NULLs and every seeded card would read
 * "never contacted" while its thread visibly contains messages. **Track B runs on this seed**, so that
 * would have surfaced as a product defect that was really a fixture defect (feature 018's lesson, one
 * field over).
 *
 * ── Why derived rather than written into each fixture by hand ────────────────────────────────────
 * A hand-written stamp is a second statement of the same fact, and the two would drift the first time
 * someone adds a message to an existing conversation fixture — silently, because nothing would fail.
 * `seed.build.spec.ts` asserts this derivation against the fixtures, which is the same property
 * `migration-022.spec.ts` asserts for the backfill and Track B asserts for live rows.
 */
export function deriveContactStamps<
  C extends { id: string },
  M extends { conversation_id: string; author_type: string; private?: boolean; created_at: Date },
>(conversations: C[], messages: M[]) {
  return conversations.map((c) => {
    const stamps: { last_inbound_at: Date | null; last_outbound_at: Date | null } = {
      last_inbound_at: null,
      last_outbound_at: null,
    };
    for (const m of messages) {
      if (m.conversation_id !== c.id) continue;
      const column = decideContactStamp(m.author_type, m.private ?? false);
      if (!column) continue; // a private note and a system entry are inert (SEC-13 / roadmap 4.7)
      const current = stamps[column];
      if (!current || m.created_at > current) stamps[column] = m.created_at;
    }
    return { ...c, ...stamps };
  });
}

export function buildSeed() {
  const seed = {
    /**
     * ⭐ Feature 032 (roadmap 4.16, ADR 0040 §3) — the nine statuses this team already works by.
     *
     * ⚠️ **Written BEFORE the conversations, and that ordering is load-bearing:** `Conversation.status`
     * carries a composite foreign key into this table, so a fixture ticket cannot exist until the
     * vocabulary it names does. The seed runner enforces the order; a future fixture that adds a
     * conversation with a status nobody configured fails loudly on the constraint rather than quietly
     * storing a word no read can resolve.
     *
     * Built from `SEEDED_STATUSES` in `@crm/common` — the same constant the SQL migration's nine rows come
     * from, so a fresh database and a migrated one cannot end up with different vocabularies.
     */
    statuses: SEEDED_STATUSES.map((st) => ({
      id: `seed-status-${st.key}`,
      account_id: SEED_ACCOUNT_ID,
      key: st.key,
      category: st.category as string,
      agent_name: st.agentName,
      end_user_name: st.endUserName,
      active: true,
      order: st.order,
    })),
    /**
     * ⭐ Feature 033 (roadmap 6.5, subpoint 2.1h) — the two configured channels.
     *
     * One API key and one mail address, both for brand 1. Provisioned here rather than through a screen:
     * the authoring surface is roadmap 3.10 / block W15, and this seed is what knows the brand ids.
     *
     * ⚠️ **No secret is stored on the row, and none can be.** Verifying an HMAC needs the key material, so
     * unlike feature 028's invite token a channel secret cannot be a hash — and a recoverable secret at
     * rest needs encryption plus key management that one MVP channel does not justify. The secret lives in
     * `CHANNEL_SECRETS`, keyed by `key`, and `SEED_CHANNEL_API_KEY` must appear there or every delivery is
     * refused as unverifiable.
     *
     * Only brand 1 gets channels, deliberately: brand 2 exists in the fixtures precisely so that
     * "a delivery signed for brand 1 cannot create a ticket under brand 2" is a falsifiable claim, and
     * giving brand 2 its own channel would make the isolation test pass for the wrong reason.
     */
    channels: [
      /**
       * ⭐ W5 (subpoint 2.4): both channels push to Desk A — the one seeded desk that is `routable` and
       * staffed (auth's seed makes that an explicit statement, not a default). This is what makes "a
       * ticket from a channel reaches a specific agent" observable on a fresh database: intake enqueues
       * to this desk, the drain assigns to its members. The value is an EXPLICIT choice here for the
       * same reason `Group.routable` is: NULL is "not push-routed", and the seed must not leave the
       * demo in an undecided state the live run would then read as a defect.
       */
      {
        id: SEED_CHANNEL_API_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        kind: SEED_CHANNEL_API,
        key: SEED_CHANNEL_API_KEY,
        address: null as string | null,
        enabled: true,
        default_group_id: SEED_GROUP_A_ID as string | null,
      },
      {
        id: SEED_CHANNEL_EMAIL_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        kind: SEED_CHANNEL_EMAIL,
        key: SEED_CHANNEL_EMAIL_KEY,
        address: SEED_CHANNEL_EMAIL_ADDRESS as string | null,
        enabled: true,
        default_group_id: SEED_GROUP_A_ID as string | null,
      },
    ],
    labels: [
      { id: SEED_LABEL_ID, account_id: SEED_ACCOUNT_ID, name: 'seed-demo' },
      // feature 013 (US2): a second label so attach/detach has a target that is NOT already linked.
      { id: SEED_LABEL_ID_2, account_id: SEED_ACCOUNT_ID, name: 'seed-followup' },
      // ⭐ W21 (subpoint 7.3): the team's own Zendesk tag taxonomy, seeded 1:1 so the tag registry
      // (W16) and the pickers read the vocabulary testers already know. A SEED, not a migration —
      // names only, the six-figure usage counts stay in Zendesk (14.x owns history).
      { id: 'seed-label-zd-000000000000001', account_id: SEED_ACCOUNT_ID, name: 'auto_confirmation' },
      { id: 'seed-label-zd-000000000000002', account_id: SEED_ACCOUNT_ID, name: 'regular' },
      { id: 'seed-label-zd-000000000000003', account_id: SEED_ACCOUNT_ID, name: 'bot_managed' },
      { id: 'seed-label-zd-000000000000004', account_id: SEED_ACCOUNT_ID, name: 'bot_escalation' },
      { id: 'seed-label-zd-000000000000005', account_id: SEED_ACCOUNT_ID, name: 'vip' },
      { id: 'seed-label-zd-000000000000006', account_id: SEED_ACCOUNT_ID, name: 'bonus' },
      { id: 'seed-label-zd-000000000000007', account_id: SEED_ACCOUNT_ID, name: 'payments' },
      { id: 'seed-label-zd-000000000000008', account_id: SEED_ACCOUNT_ID, name: 'kyc' },
    ],
    /**
     * ⭐ Feature 037 (roadmap 4.15 — W30): custom ticket fields, EXAMPLES not migration (D14).
     *
     * The capture's 12 form names, the frame-032 Deposits cascade with its observed values
     * (Deposit status → Declined → Timeout, PSP Betterbro, Country Argentina), and the four shared
     * dropdowns. ⚠️ The full option-value sets are ABSENT from the capture and come from the
     * operator — the /admin/fields screen this block builds is where they land; these rows exist so
     * the mechanism is provable live and the screen opens recognisable. NO field is `restricted`
     * (Q15: nothing limited by default) and no conversation carries a form — agents choose one.
     */
    optionSets: [
      { id: 'seed-oset-deposits-topics', account_id: SEED_ACCOUNT_ID, name: 'Deposits topics' },
      { id: 'seed-oset-deposit-status', account_id: SEED_ACCOUNT_ID, name: 'Deposit status' },
      { id: 'seed-oset-deposit-declined', account_id: SEED_ACCOUNT_ID, name: 'Deposit declined reasons' },
      { id: 'seed-oset-countries', account_id: SEED_ACCOUNT_ID, name: 'Countries' },
      { id: 'seed-oset-psp', account_id: SEED_ACCOUNT_ID, name: 'PSP' },
      { id: 'seed-oset-contact-type', account_id: SEED_ACCOUNT_ID, name: 'Type of contact' },
      { id: 'seed-oset-user-level', account_id: SEED_ACCOUNT_ID, name: 'User level' },
    ],
    optionValues: [
      // Frame 032's observed value first in each set — the live check drives exactly this path.
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dt-1', option_set_id: 'seed-oset-deposits-topics', value: 'Deposit status', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dt-2', option_set_id: 'seed-oset-deposits-topics', value: 'Deposit not reflected', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dt-3', option_set_id: 'seed-oset-deposits-topics', value: 'Deposit delay', order: 20, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ds-1', option_set_id: 'seed-oset-deposit-status', value: 'Declined', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ds-2', option_set_id: 'seed-oset-deposit-status', value: 'Pending', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ds-3', option_set_id: 'seed-oset-deposit-status', value: 'Approved', order: 20, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dd-1', option_set_id: 'seed-oset-deposit-declined', value: 'Timeout', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dd-2', option_set_id: 'seed-oset-deposit-declined', value: 'Insufficient funds', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-dd-3', option_set_id: 'seed-oset-deposit-declined', value: 'Provider error', order: 20, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-co-1', option_set_id: 'seed-oset-countries', value: 'Argentina', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-co-2', option_set_id: 'seed-oset-countries', value: 'Brazil', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-co-3', option_set_id: 'seed-oset-countries', value: 'Chile', order: 20, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ps-1', option_set_id: 'seed-oset-psp', value: 'Betterbro (Src H2H)', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ps-2', option_set_id: 'seed-oset-psp', value: 'PayCord', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ps-3', option_set_id: 'seed-oset-psp', value: 'Directa24', order: 20, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ct-1', option_set_id: 'seed-oset-contact-type', value: 'Regular', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ct-2', option_set_id: 'seed-oset-contact-type', value: 'VIP', order: 10, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ul-1', option_set_id: 'seed-oset-user-level', value: 'Regular', order: 0, active: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-oval-ul-2', option_set_id: 'seed-oset-user-level', value: 'VIP', order: 10, active: true },
    ],
    fieldDefinitions: [
      // The Deposits cascade (frame 032). Labels are the capture's own; keys are theirs normalised.
      { id: 'seed-field-l1-deposits', account_id: SEED_ACCOUNT_ID, key: 'l1_deposits', label: 'Form L1 - Deposits', type: 'dropdown', required: true, restricted: false, option_set_id: 'seed-oset-deposits-topics' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-l2-deposit-status', account_id: SEED_ACCOUNT_ID, key: 'l2_deposit_status', label: 'Form L2 - Deposit status', type: 'dropdown', required: true, restricted: false, option_set_id: 'seed-oset-deposit-status' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-l3-deposit-declined', account_id: SEED_ACCOUNT_ID, key: 'l3_deposit_declined', label: 'Level 3 - Deposit/Declined', type: 'dropdown', required: false, restricted: false, option_set_id: 'seed-oset-deposit-declined' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-country', account_id: SEED_ACCOUNT_ID, key: 'country', label: 'Country', type: 'dropdown', required: true, restricted: false, option_set_id: 'seed-oset-countries' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-psp', account_id: SEED_ACCOUNT_ID, key: 'psp', label: 'PSP', type: 'dropdown', required: false, restricted: false, option_set_id: 'seed-oset-psp' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-type-of-contact', account_id: SEED_ACCOUNT_ID, key: 'type_of_contact', label: 'Type of contact', type: 'dropdown', required: false, restricted: false, option_set_id: 'seed-oset-contact-type' as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-user-level', account_id: SEED_ACCOUNT_ID, key: 'user_level', label: 'User Level', type: 'dropdown', required: false, restricted: false, option_set_id: 'seed-oset-user-level' as string | null, brand_ids: [] as string[], active: true },
      // One of each remaining TYPE, so every widget and validator is reachable from the seed alone.
      { id: 'seed-field-deposit-amount', account_id: SEED_ACCOUNT_ID, key: 'deposit_amount', label: 'Deposit Amount', type: 'numeric', required: false, restricted: false, option_set_id: null as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-transaction-id', account_id: SEED_ACCOUNT_ID, key: 'transaction_id', label: 'Transaction ID', type: 'text', required: false, restricted: false, option_set_id: null as string | null, brand_ids: [] as string[], active: true },
      { id: 'seed-field-comments', account_id: SEED_ACCOUNT_ID, key: 'comments', label: 'Comments', type: 'multiline', required: false, restricted: false, option_set_id: null as string | null, brand_ids: [] as string[], active: true },
    ],
    /**
     * The capture's 12 forms (§17: drag-to-reorder, agent-only). Topic forms carry their topic as
     * the CATEGORY (D2 — the form files the ticket; analytics reads the reserved column); Default
     * and Ghost Contact are neutral. Only Deposits carries entries — the worked example.
     */
    forms: [
      { id: 'seed-form-default', account_id: SEED_ACCOUNT_ID, key: 'default', name: 'Default', category: null as string | null, active: true, order: 0 },
      { id: 'seed-form-ghost-contact', account_id: SEED_ACCOUNT_ID, key: 'ghost_contact', name: 'Ghost Contact', category: null as string | null, active: true, order: 10 },
      { id: 'seed-form-general', account_id: SEED_ACCOUNT_ID, key: 'general', name: 'General', category: 'General' as string | null, active: true, order: 20 },
      { id: 'seed-form-account', account_id: SEED_ACCOUNT_ID, key: 'account', name: 'Account', category: 'Account' as string | null, active: true, order: 30 },
      { id: 'seed-form-issues', account_id: SEED_ACCOUNT_ID, key: 'issues', name: 'Issues', category: 'Issues' as string | null, active: true, order: 40 },
      { id: 'seed-form-verification', account_id: SEED_ACCOUNT_ID, key: 'verification', name: 'Verification', category: 'Verification' as string | null, active: true, order: 50 },
      { id: 'seed-form-product', account_id: SEED_ACCOUNT_ID, key: 'product', name: 'Product', category: 'Product' as string | null, active: true, order: 60 },
      { id: 'seed-form-promotions', account_id: SEED_ACCOUNT_ID, key: 'promotions_and_bonus', name: 'Promotions and bonus', category: 'Promotions and bonus' as string | null, active: true, order: 70 },
      { id: 'seed-form-withdrawal', account_id: SEED_ACCOUNT_ID, key: 'withdrawal', name: 'Withdrawal', category: 'Withdrawal' as string | null, active: true, order: 80 },
      { id: 'seed-form-deposits', account_id: SEED_ACCOUNT_ID, key: 'deposits', name: 'Deposits', category: 'Deposits' as string | null, active: true, order: 90 },
      { id: 'seed-form-sportsbooks', account_id: SEED_ACCOUNT_ID, key: 'sportsbooks', name: 'Sportsbooks', category: 'Sportsbooks' as string | null, active: true, order: 100 },
      { id: 'seed-form-vip-topics', account_id: SEED_ACCOUNT_ID, key: 'vip_topics', name: 'VIP Topics', category: 'VIP Topics' as string | null, active: true, order: 110 },
    ],
    formFields: [
      // The frame-032 column, top to bottom. L1 is the SUB-CATEGORY SOURCE (its value writes the
      // reserved column); L2 appears under L1 = 'Deposit status'; L3 under L2 = 'Declined'.
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-l1', form_id: 'seed-form-deposits', field_id: 'seed-field-l1-deposits', order: 0, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: true },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-l2', form_id: 'seed-form-deposits', field_id: 'seed-field-l2-deposit-status', order: 10, condition_field_id: 'seed-field-l1-deposits' as string | null, condition_value: 'Deposit status' as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-l3', form_id: 'seed-form-deposits', field_id: 'seed-field-l3-deposit-declined', order: 20, condition_field_id: 'seed-field-l2-deposit-status' as string | null, condition_value: 'Declined' as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-country', form_id: 'seed-form-deposits', field_id: 'seed-field-country', order: 30, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-psp', form_id: 'seed-form-deposits', field_id: 'seed-field-psp', order: 40, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-contact', form_id: 'seed-form-deposits', field_id: 'seed-field-type-of-contact', order: 50, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-level', form_id: 'seed-form-deposits', field_id: 'seed-field-user-level', order: 60, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-amount', form_id: 'seed-form-deposits', field_id: 'seed-field-deposit-amount', order: 70, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-txn', form_id: 'seed-form-deposits', field_id: 'seed-field-transaction-id', order: 80, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
      { account_id: SEED_ACCOUNT_ID, id: 'seed-ff-dep-comments', form_id: 'seed-form-deposits', field_id: 'seed-field-comments', order: 90, condition_field_id: null as string | null, condition_value: null as string | null, is_subcategory_source: false },
    ],
    conversations: [
      {
        id: SEED_CONVERSATION_OPEN_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'high', // feature 012: exercise priority filtering (4.1)
        assignee_operator_id: SEED_OPERATOR_ID,
        /**
         * ⭐ A plausible support title, added 2026-08-03.
         *
         * The seeded conversations carried **no** subject, so the Inbox showed "no subject" beside a
         * wall of `совершенно неверный заголовок` — a test string that feature 023's live script
         * stamped across every row and restored on only one (fixed in that script). The operator saw
         * the result and, reasonably, called it ugly.
         *
         * ⚠️ Deliberately mundane, brand-neutral, and free of any contact detail: the subject is the
         * one place customer-authored text reaches the queue unmasked (SEC-43).
         */
        subject: 'Deposit not credited after 30 minutes' as string | null,
        subject_source: 'manual' as string | null,
        category: null as string | null, // unclassified is valid (reserved, ADR 0027)
        classified_by: null as string | null,
      },
      /**
       * ── Feature 029 (roadmap 9.2, FR-024): three categories, for judging the Inbox ────────────
       *
       * The operator asked for these so the screen can be judged on something that looks like work.
       * ⚠️ They exist HERE because there is no `POST /conversations` at the REST edge — a
       * conversation is opened by channel ingestion, and Phase 6 owns the channels.
       *
       * Each carries a distinct `channel` and `category`, so the Inbox's channel filter and its
       * Category column both have something real to show. `subject_source: 'manual'` pins the title
       * against the derivation sweep (feature 023): a fixture may declare a starting state, and this
       * one must stay legible across re-seeds.
       */
      {
        id: SEED_CONVERSATION_TEST_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'open',
        priority: 'high',
        // ⚠️ Feature 033: was `'chat'`. The 033 migration folds that value into `api` — the widget chat IS
        // the API channel (roadmap 6.1) — so a fixture still writing it would seed a fresh database into
        // the pre-migration vocabulary while a migrated one held the new. A seed is the quietest place a
        // retired vocabulary grows back, which is why `seed.build.spec.ts` now scans for it.
        channel: SEED_CHANNEL_API,
        assignee_operator_id: SEED_OPERATOR_ID,
        subject: 'Card payment declined twice' as string | null,
        subject_source: 'manual' as string | null,
        category: 'Test' as string | null,
        classified_by: null as string | null,
      },
      {
        id: SEED_CONVERSATION_BILLING_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'pending',
        priority: 'normal',
        channel: 'email',
        assignee_operator_id: null as string | null,
        subject: 'Withdrawal still pending after two days' as string | null,
        subject_source: 'manual' as string | null,
        category: 'Billing' as string | null,
        classified_by: null as string | null,
      },
      {
        // ⚠️ Feature 033: this fixture's channel became NULL, and it is a better fixture for it.
        //
        // Before 033 the three judging conversations carried `chat`, `email` and `api` — three words. The
        // migration folds `chat` into `api`, so two of the three would now be identical and the Inbox
        // filter would have less to do, not more.
        //
        // NULL is the third case that actually exists in the data: about one in six conversations have no
        // arrival channel, `conversation.repository.ts` warns that a `channel: null` predicate must never
        // be introduced, and the filter's own comment records that there is deliberately no "no channel"
        // option. So the screen now has a row the filter CANNOT narrow to — which is the case most worth
        // seeing with your own eyes, and the one a fixture of three tidy words was hiding.
        id: SEED_CONVERSATION_ACCESS_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        status: 'solved',
        priority: 'low',
        channel: null as string | null,
        assignee_operator_id: SEED_OPERATOR_ID,
        subject: 'Cannot sign in after password reset' as string | null,
        subject_source: 'manual' as string | null,
        category: 'Access' as string | null,
        classified_by: null as string | null,
      },
      {
        id: SEED_CONVERSATION_PENDING_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        // ⭐ Feature 032: `vip_pending` — a status the flat enum had no room for. Left on a PENDING-category
        // status so every list filter that used to select this row still selects it.
        status: 'vip_pending',
        priority: 'normal',
        subject: 'Bonus wagering balance looks wrong' as string | null,
        subject_source: 'manual' as string | null,
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
        // Feature 022: the ONLY conversation of this player with a RECORDED channel. Its siblings carry
        // none (the state the whole existing history is in until Phase 6), so the rollup has a named entry
        // next to the unrecorded bucket — which is what makes "the per-channel counts sum to the total" a
        // real assertion rather than a trivially true one.
        channel: SEED_CHANNEL_EMAIL as string | null,
      },
      {
        id: SEED_CONVERSATION_RESOLVED_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        // Feature 032: `resolved` → `solved` (ADR 0040 §5). The word changed; the meaning did not.
        status: 'solved',
        priority: 'low',
        assignee_operator_id: SEED_OPERATOR_ID,
        subject: 'Verification documents rejected twice' as string | null,
        subject_source: 'manual' as string | null,
        category: 'billing',
        classified_by: 'seed',
      },
      {
        // feature 013 (US1): starts with NO assignee — the assign/reassign/unassign fixture.
        id: SEED_CONVERSATION_UNASSIGNED_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        subject: 'Cannot complete withdrawal to card' as string | null,
        subject_source: 'manual' as string | null,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
      },
      {
        // feature 014 (US2): the first-reply SLA fixture — no messages yet, so the Track-B script
        // drives its clock from a known-empty state (inbound starts it, a public reply stops it).
        id: SEED_CONVERSATION_SLA_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        subject: 'Live chat disconnected mid-conversation' as string | null,
        subject_source: 'manual' as string | null,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
      },
      {
        // feature 012 (US3): SAME player, a SECOND brand — proves the player brand-union in the
        // feed (one player_id spanning brands within the account; never crosses accounts).
        id: SEED_CONVERSATION_BRAND2_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID_2,
        player_id: SEED_PLAYER_ID,
        subject: 'Promo code not applying at checkout' as string | null,
        subject_source: 'manual' as string | null,
        // ⭐ Feature 032: `in_progress` — category ON_HOLD, agent-facing *In progress*, player-facing
        // *Open*. The dual naming is only visible on a row that actually uses it, and this is the row the
        // live round reads to prove it. Non-terminal, so it still counts against its assignee's load —
        // which the old `['open','pending']` list would have missed.
        status: 'in_progress',
        priority: 'normal',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
      },
      /**
       * ── Feature 022 (roadmap 4.13): the LINKED person's two conversations, one per brand ────────
       *
       * Two DISTINCT platform ids (not the collision pair), explicitly linked into one person in users_db.
       * Contact lands at different times under each brand, so the person-level read is falsifiable: if it
       * quietly answered the player-level question, the later timestamp would be missing.
       */
      {
        id: SEED_CONVERSATION_LINKED_A_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_LINKED_A,
        subject: 'Duplicate charge on the same deposit' as string | null,
        subject_source: 'manual' as string | null,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null as string | null,
        category: null as string | null,
        classified_by: null as string | null,
        channel: SEED_CHANNEL_EMAIL as string | null,
      },
      {
        id: SEED_CONVERSATION_LINKED_B_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID_2,
        player_id: SEED_PLAYER_LINKED_B,
        subject: 'Requesting a self-exclusion period' as string | null,
        subject_source: 'manual' as string | null,
        status: 'open',
        priority: 'normal',
        assignee_operator_id: SEED_OPERATOR_ID,
        category: null as string | null,
        classified_by: null as string | null,
        // A DIFFERENT channel from the other brand's, so "they write on one channel and we answer on
        // another" is observable across the person's records rather than only in theory.
        channel: SEED_CHANNEL_API as string | null,
      },
    ],
    messages: [
      /**
       * Feature 029 (FR-024) — the `Test` conversation's short exchange.
       *
       * Four turns, customer → agent → customer → agent, so the Inbox is judged against a thread that
       * reads like real work. The other two categories get one inbound each: enough to be legitimate
       * conversations with derived contact stamps, without pretending every ticket has a dialogue.
       *
       * ⚠️ Deliberately mundane and brand-neutral — nothing here should read as a real customer, and
       * no message carries a contact detail (the subject column is the one place customer-authored
       * text reaches the queue unmasked).
       */
      {
        id: SEED_MESSAGE_TEST_1_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_TEST_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'Card payment declined twice, but the bank says nothing is wrong on their side.',
        private: false,
        created_at: SEED_MESSAGE_CAT_TEST_AT,
      },
      {
        id: SEED_MESSAGE_TEST_2_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_TEST_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Thanks — I can see two declined attempts on the account. Checking with the provider now.',
        private: false,
        created_at: SEED_MESSAGE_CAT_TEST_2_AT,
      },
      {
        id: SEED_MESSAGE_TEST_3_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_TEST_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'Understood. Should I try a different card in the meantime?',
        private: false,
        created_at: SEED_MESSAGE_CAT_TEST_3_AT,
      },
      {
        id: SEED_MESSAGE_TEST_4_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_TEST_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Yes, please do. I will keep this open until the provider confirms.',
        private: false,
        created_at: SEED_MESSAGE_CAT_TEST_4_AT,
      },
      {
        id: SEED_MESSAGE_BILLING_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_BILLING_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'My withdrawal is still pending after two days. Can you check the status?',
        private: false,
        created_at: SEED_MESSAGE_CAT_BILLING_AT,
      },
      {
        id: SEED_MESSAGE_ACCESS_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_ACCESS_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'I reset my password but still cannot sign in.',
        private: false,
        created_at: SEED_MESSAGE_CAT_ACCESS_AT,
      },
      {
        id: SEED_MESSAGE_PLAYER_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_ID,
        body: 'Hello, I need help with my account.',
        private: false,
        created_at: SEED_MESSAGE_PLAYER_AT, // feature 022 — fixed, so the derived stamp is deterministic
      },
      {
        id: SEED_MESSAGE_REPLY_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Happy to help — could you share more detail?',
        private: false,
        created_at: SEED_MESSAGE_REPLY_AT,
      },
      {
        id: SEED_MESSAGE_NOTE_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Internal note: check the player segment.',
        private: true, // private note — excluded from the CUSTOMER projection at query (SEC-13)
        mentions: [SEED_OPERATOR_ID], // feature 012: @mention capture on a private note (R6)
        // Feature 022: later than the public reply on purpose. If a private note ever counted as contact,
        // `last_outbound_at` would be 09:30 instead of 09:15 — the fixture makes that mistake visible
        // instead of harmless.
        created_at: SEED_MESSAGE_NOTE_AT,
      },
      {
        /**
         * Feature 022 — a SYSTEM entry, and it is the LATEST message on this conversation.
         *
         * Machine output is not a conversation with the customer. Because this row is newer than both the
         * reply (09:15) and the note (09:30), counting it as contact would CHANGE the card's answer to
         * 09:45 rather than leave it alone — so the live run can tell the difference. A fixture that only
         * ever produced the same answer either way would prove nothing.
         */
        id: SEED_MESSAGE_SYSTEM_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_OPEN_ID,
        author_type: 'system',
        author_id: null as string | null,
        body: 'Conversation reopened by the seed fixture.',
        private: false,
        created_at: SEED_MESSAGE_SYSTEM_AT,
      },
      // ── The linked person's contact, one message per brand ────────────────────────────────────
      {
        id: SEED_MESSAGE_LINKED_A_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_A_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_LINKED_A,
        body: 'Writing from the first brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_A_AT,
      },
      {
        // LATER than the first brand's, so the person-level maximum can only come from this record.
        id: SEED_MESSAGE_LINKED_B_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_B_ID,
        author_type: 'player',
        author_id: SEED_PLAYER_LINKED_B,
        body: 'Writing from the second brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_B_AT,
      },
      {
        // …and a reply under the second brand only, so "they write on one channel, we answer on another"
        // is visible in the person's rollup.
        id: SEED_MESSAGE_LINKED_B_REPLY_ID,
        account_id: SEED_ACCOUNT_ID,
        conversation_id: SEED_CONVERSATION_LINKED_B_ID,
        author_type: 'operator',
        author_id: SEED_OPERATOR_ID,
        body: 'Answered under the second brand.',
        private: false,
        created_at: SEED_MESSAGE_LINKED_B_REPLY_AT,
      },
    ],
    conversationLabels: [{ conversation_id: SEED_CONVERSATION_OPEN_ID, label_id: SEED_LABEL_ID }],
    // feature 013 (US2): macro definitions use the v1 action shape {actions:[{type,value}]} with
    // wire-name values (research R4) — validated at define AND apply.
    macros: [
      {
        id: SEED_MACRO_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-triage',
        definition: {
          actions: [
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
          ],
        } as unknown,
      },
      {
        // Contains an ASSIGN action: applying it requires crm.conversation.assign as well, so it is
        // the all-or-nothing / permission-blocked fixture (SC-004).
        id: SEED_MACRO_ASSIGN_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-triage-and-assign',
        definition: {
          actions: [
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
            { type: 'MACRO_ACTION_TYPE_ASSIGN', value: SEED_OPERATOR_ID },
          ],
        } as unknown,
      },
    ],
    // feature 014 (US1/US3): rule definitions use {trigger, conditions, actions} with wire-name
    // values, validated at author AND at run time. `author_user_id` is the authority each rule acts
    // with — the seed user, who holds the supervisory keys (FR-023).
    automations: [
      {
        // The keyword rule: an inbound message on an UNASSIGNED conversation mentioning the keyword
        // gets labelled and moved to pending. Exercises a condition that reads message text without
        // ever storing it (FR-020).
        id: SEED_AUTOMATION_KEYWORD_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-keyword-triage',
        active: true,
        position: 0,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
          conditions: [
            { field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' },
            {
              field: 'CONDITION_FIELD_MESSAGE_TEXT',
              op: 'CONDITION_OP_CONTAINS',
              value: SEED_AUTOMATION_KEYWORD,
            },
          ],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
          ],
        } as unknown,
      },
      {
        // Contains an ASSIGN action ⇒ needs crm.conversation.assign from its AUTHOR. Revoking that
        // key from the author must leave the conversation completely unchanged (SC-002/SC-011).
        // Inactive by default so it only fires when the Track-B script enables it.
        id: SEED_AUTOMATION_ASSIGN_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-keyword-assign',
        active: false,
        position: 1,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
          conditions: [
            {
              field: 'CONDITION_FIELD_MESSAGE_TEXT',
              op: 'CONDITION_OP_CONTAINS',
              value: SEED_AUTOMATION_KEYWORD,
            },
          ],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_ASSIGN', value: SEED_OPERATOR_ID },
          ],
        } as unknown,
      },
      {
        // DELIBERATELY self-satisfying: triggered by a status change, and its action IS a status
        // change. Under a naive design this loops forever; here it cannot, because only controllers
        // publish events (FR-006 / SC-004). Inactive by default — enabled by the Track-B scenario.
        id: SEED_AUTOMATION_SELF_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-self-satisfying',
        active: false,
        position: 2,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
          conditions: [],
          actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }],
        } as unknown,
      },
      {
        // The US3 join: reacts to a missed first-reply target (label + raise priority).
        id: SEED_AUTOMATION_BREACH_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-breach-escalation',
        active: true,
        position: 3,
        author_user_id: SEED_AUTH_USER_ID,
        definition: {
          trigger: 'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
          conditions: [],
          actions: [
            { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: SEED_LABEL_ID_2 },
            { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
          ],
        } as unknown,
      },
    ],
    // feature 014 (US2): one account-level target ('*'/'*' = any priority, any brand). Short on
    // purpose so a breach is observable within seconds on Track B (SC-006).
    slaPolicies: [
      {
        id: SEED_SLA_POLICY_ID,
        account_id: SEED_ACCOUNT_ID,
        target_minutes: SEED_SLA_TARGET_MINUTES,
        scope_priority: '*',
        scope_brand_id: '*',
      },
    ],
    cannedResponses: [
      {
        id: SEED_CANNED_RESPONSE_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'seed-greeting',
        body: 'Thanks for reaching out — I am looking into this now.',
      },
    ],
  };

  // Feature 022: the conversations carry their contact stamps, derived from the messages above by the
  // production rule. Applied here rather than inside the literal so a new message fixture cannot leave a
  // stale stamp behind — there is nothing to update.
  return { ...seed, conversations: deriveContactStamps(seed.conversations, seed.messages) };
}

export type ChatsSeed = ReturnType<typeof buildSeed>;
