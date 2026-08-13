import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_OPERATOR_ID,
  SEED_PLAYER_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  // feature 022 (roadmap 4.13): the explicitly linked cross-brand person.
  SEED_PLAYER_LINKED_A,
  SEED_PLAYER_LINKED_B,
  SEED_PERSON_ID,
  SEED_PERSON_LINKED_ON,
  SEED_ROUTING_OPERATOR_IDS,
  SEED_PRESENCE_LABEL_IDS,
  SEED_ROUTING_USER_IDS,
} from '@crm/common';

/**
 * Pure synthetic dataset for users_db (feature 008). No I/O — unit-testable (Track A).
 * The GR8 cache seam is left unpopulated/stale (7.4 populates it).
 *
 * ── ⚠️ THE COLLISION IS A PERMANENT FIXTURE (feature 020) ───────────────────────────────────────
 * The same platform `player_id` appears under BOTH brands, as TWO DIFFERENT PEOPLE with different
 * notes, different VIP flags and different segments. That is not a contrived test case: GR8's
 * `player_id` is unique only WITHIN a brand, so this is what the real data looks like.
 *
 * It lives in the seed rather than in one test's setup so that **every** future live run carries it.
 * The defect it guards against — two customers collapsing into one row, and one person's card showing
 * another's conversations — survived four phases precisely because nothing routinely exercised it.
 * A fixture that has to be staged is a fixture that gets skipped.
 *
 * The brand-union edge is gone with `PlayerBrand`: a row's brand is part of its key now. A human who
 * genuinely plays under both brands is a `Person`, established from a matching email or phone.
 */
export function buildSeed() {
  return {
    operators: [
      {
        id: SEED_OPERATOR_ID,
        account_id: SEED_ACCOUNT_ID,
        auth_user_id: SEED_AUTH_USER_ID, // soft ref to auth.User.id (no cross-service FK)
        display_name: 'Seed Operator',
        active: true,
      },
      // Feature 024 (roadmap 5.3): a profile for each seeded agent. Without these, the seeded groups
      // resolve to auth identities that cannot hold work, every routing pool comes back empty, and a
      // live run would report the product as broken when it is the fixture that is incomplete —
      // exactly the failure feature 021's Track B hit one field over.
      ...SEED_ROUTING_OPERATOR_IDS.map((id, i) => ({
        id,
        account_id: SEED_ACCOUNT_ID,
        auth_user_id: SEED_ROUTING_USER_IDS[i]!,
        display_name: `Seed Agent ${i + 1}`,
        active: true,
      })),
    ],
    // ── Feature 025 (roadmap 5.9): the label set ────────────────────────────────────────────────
    //
    // The four the operator named, each pointing at exactly ONE state. Ids are fixed so re-seeding is
    // idempotent; NAMES are data and nothing in the product branches on one
    // (`tests/contracts/presence-label-never-branched-on.spec.ts`).
    presenceLabels: [
      { id: SEED_PRESENCE_LABEL_IDS[0]!, account_id: SEED_ACCOUNT_ID, name: 'Break', state: 'away' },
      { id: SEED_PRESENCE_LABEL_IDS[1]!, account_id: SEED_ACCOUNT_ID, name: 'Lunch', state: 'away' },
      {
        id: SEED_PRESENCE_LABEL_IDS[2]!,
        account_id: SEED_ACCOUNT_ID,
        name: 'Meeting',
        state: 'transfers_only',
      },
      {
        id: SEED_PRESENCE_LABEL_IDS[3]!,
        account_id: SEED_ACCOUNT_ID,
        name: 'VIP task',
        state: 'transfers_only',
      },
    ],
    players: [
      {
        player_id: SEED_PLAYER_ID,
        brand_id: SEED_BRAND_ID,
        account_id: SEED_ACCOUNT_ID,
        vip: false,
        segment: 'standard',
        am_notes: null,
        gr8_stale: true, // GR8 seam unpopulated → stale/unknown
      },
      {
        // SAME platform id, OTHER brand, DIFFERENT person. Every field that differs here is a field
        // the old single-column key would have silently overwritten with the other person's value.
        player_id: SEED_PLAYER_ID,
        brand_id: SEED_BRAND_ID_2,
        account_id: SEED_ACCOUNT_ID,
        vip: true,
        segment: 'high-roller',
        am_notes: 'second brand, different human — feature 020 collision fixture',
        gr8_stale: true,
      },
      /**
       * ── Feature 022 (roadmap 4.13): the LINKED pair, and why it is a DIFFERENT pair ─────────────
       *
       * The two records above share a platform id and are two humans. These two have DISTINCT platform ids
       * and are ONE human, linked explicitly. Both fixtures are needed because they prove opposite things,
       * and the live run cannot tell them apart without both: with only the collision pair, "the person feed
       * spans brands" is unfalsifiable; with only the linked pair, "an id match is not a person" is.
       */
      {
        player_id: SEED_PLAYER_LINKED_A,
        brand_id: SEED_BRAND_ID,
        account_id: SEED_ACCOUNT_ID,
        vip: false,
        segment: 'standard',
        am_notes: null,
        gr8_stale: true,
      },
      {
        player_id: SEED_PLAYER_LINKED_B,
        brand_id: SEED_BRAND_ID_2,
        account_id: SEED_ACCOUNT_ID,
        vip: false,
        segment: 'standard',
        am_notes: null,
        gr8_stale: true,
      },
    ],
    /**
     * The person the two records above make up (feature 020's entity, feature 022's first consumer).
     *
     * `linked_on` records WHICH KIND of identifier established the link — never the value (SEC-26). The seed
     * asserts the link directly rather than by seeding two matching contact hashes and letting the matcher
     * run: a fixture that depends on another feature's inference would fail for reasons that are not this
     * feature's, and feature 018's live run already taught that lesson once.
     */
    persons: [{ id: SEED_PERSON_ID, account_id: SEED_ACCOUNT_ID }],
    personMembers: [
      {
        person_id: SEED_PERSON_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_LINKED_A,
        linked_on: SEED_PERSON_LINKED_ON,
      },
      {
        person_id: SEED_PERSON_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID_2,
        player_id: SEED_PLAYER_LINKED_B,
        linked_on: SEED_PERSON_LINKED_ON,
      },
    ],
    /**
     * ── ⭐ W35 / feature 040 (R35 · U17): two notes, by TWO DIFFERENT AUTHORS ────────────────────
     *
     * The second author is the whole point of seeding any at all. The block's own requirement is that
     * after a handover a manager reads *somebody else's* notes and can see whose — and a fixture where
     * every note is by the caller would render the signature and prove nothing about it. So one note is
     * the seed operator's and one is a seeded agent's, and the screen shows two different names without
     * anybody staging a transfer.
     *
     * ⚠️ **Both are PLAIN notes — no `pattern_kinds` — and that is deliberate rather than lazy.** In the
     * product a flagged note ALWAYS arrives with an audit entry written in the same transaction; a seed
     * that inserted `pattern_kinds: 'phone'` as a row would create the one state the product cannot
     * produce, and the first check that counted entries would disagree with the table. That is the
     * *fixture-is-not-what-the-script-believes* class, pre-installed. The flagged path is exercised
     * where it belongs: through the product, in the live run.
     *
     * `client_ref` values are fixed so a re-seed is idempotent against the unique index rather than
     * accumulating a note per run.
     */
    playerNotes: [
      {
        id: 'seed-note-0000-0000-000000000001',
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        body: 'Играет по выходным, вопросы почти всегда про вывод. Обещали ответ в течение часа.',
        author_auth_user_id: SEED_AUTH_USER_ID,
        pattern_kinds: '',
        client_ref: 'seed-note-ref-1',
      },
      {
        id: 'seed-note-0000-0000-000000000002',
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        player_id: SEED_PLAYER_ID,
        body: 'Просил не звонить до обеда — писать в чат. Передаю следующему менеджеру.',
        author_auth_user_id: SEED_ROUTING_USER_IDS[0]!,
        pattern_kinds: '',
        client_ref: 'seed-note-ref-2',
      },
    ],
  };
}

export type UsersSeed = ReturnType<typeof buildSeed>;
