import {
  buildSeed,
  deriveContactStamps,
  SEED_MESSAGE_PLAYER_AT,
  SEED_MESSAGE_REPLY_AT,
} from './seed.build';
import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
  SEED_PLAYER_ID,
  // Feature 029 (FR-024) — the three conversations for judging the Inbox.
  SEED_CONVERSATION_TEST_ID,
  SEED_CONVERSATION_BILLING_ID,
  SEED_CONVERSATION_ACCESS_ID,
  SEED_CONVERSATION_OPEN_ID,
  SEED_CONVERSATION_UNASSIGNED_ID,
  SEED_MACRO_ID,
  SEED_MACRO_ASSIGN_ID,
  SEED_AUTOMATION_KEYWORD_ID,
  SEED_AUTOMATION_ASSIGN_ID,
  SEED_AUTOMATION_SELF_ID,
  SEED_AUTOMATION_BREACH_ID,
  SEED_AUTOMATION_KEYWORD,
  SEED_CONVERSATION_SLA_ID,
  // feature 022 (roadmap 4.13).
  SEED_PLAYER_LINKED_A,
  SEED_PLAYER_LINKED_B,
  // Feature 032 (roadmap 4.16): the nine configured statuses.
  SEEDED_STATUSES,
  isStatusCategory,
  NON_TERMINAL_CATEGORIES,
} from '@crm/common';

/**
 * US1 (feature 008): the chats seed builder yields a label + two conversations (reserved classification
 * exercised) + messages (incl. a private note) + a conversation-label link. Pure — no DB (Track A).
 */
describe('chats seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [
      ...seed.labels,
      ...seed.conversations,
      ...seed.messages,
      ...seed.macros,
      ...seed.cannedResponses,
    ]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('conversations share the player and span two brands (player brand-union, feature 012 US3)', () => {
    /**
     * ⚠️ **NARROWED by feature 022, and the original wording is why.** This read "for every conversation,
     * `player_id` is `SEED_PLAYER_ID`" — true only while the fixture had exactly one player. Feature 022 added
     * the LINKED pair (two distinct platform ids, one per brand, explicitly one human), which is a different
     * fixture proving a different thing, so the assertion now scopes itself to the player it is about.
     *
     * What it still proves is untouched: one platform id appearing under BOTH brands — which, since feature
     * 020, is two humans and the reason the feed keys on the triple.
     */
    const collisionPlayer = seed.conversations.filter((c) => c.player_id === SEED_PLAYER_ID);
    expect(collisionPlayer.length).toBeGreaterThan(1);
    const brands = new Set(collisionPlayer.map((c) => c.brand_id));
    expect(brands.has(SEED_BRAND_ID)).toBe(true);
    expect(brands.has(SEED_BRAND_ID_2)).toBe(true); // same player_id spanning brands
    // at least one conversation is classified (reserved fields, ADR 0027)
    expect(seed.conversations.some((c) => c.category === 'billing' && c.classified_by === 'seed')).toBe(true);
  });

  it('feature 022: the LINKED pair is a SECOND, opposite fixture — distinct ids, one per brand', () => {
    // The two fixtures prove opposite things and the live run needs both: with only the collision pair,
    // "the person feed spans brands" is unfalsifiable; with only the linked pair, "an id match is not a
    // person" is.
    const a = seed.conversations.find((c) => c.player_id === SEED_PLAYER_LINKED_A)!;
    const b = seed.conversations.find((c) => c.player_id === SEED_PLAYER_LINKED_B)!;
    expect(a.brand_id).toBe(SEED_BRAND_ID);
    expect(b.brand_id).toBe(SEED_BRAND_ID_2);
    // Distinct platform ids — that is what makes them a LINK rather than a collision.
    expect(a.player_id).not.toBe(b.player_id);
    // Different recorded channels, so a per-channel rollup across the person is observable.
    expect(a.channel).not.toBe(b.channel);
    // And the second brand's contact is LATER, so the person-level maximum can only come from it.
    expect(b.last_inbound_at!.getTime()).toBeGreaterThan(a.last_inbound_at!.getTime());
  });

  it('feature 022: a SYSTEM entry is the newest message on the open conversation, and stamps nothing', () => {
    const system = seed.messages.filter((m) => m.author_type === 'system');
    expect(system).toHaveLength(1);
    const open = seed.conversations.find((c) => c.id === SEED_CONVERSATION_OPEN_ID)!;
    const newest = Math.max(
      ...seed.messages
        .filter((m) => m.conversation_id === SEED_CONVERSATION_OPEN_ID)
        .map((m) => m.created_at.getTime()),
    );
    // The system row IS the newest — so counting machine output as contact would change the answer.
    expect(system[0]!.created_at.getTime()).toBe(newest);
    expect(open.last_outbound_at!.getTime()).toBeLessThan(newest);
  });

  /**
   * ⚠️ RELAXED by feature 029, deliberately — from `toHaveLength(1)` to "at least one of each".
   *
   * The property this protects is that the contact rollup has **both** an identified channel entry
   * **and** an unrecorded bucket, so "the counts sum to the total" is not trivially true. Exactly one
   * named channel was never the requirement; it was simply how many the fixture had at the time.
   *
   * Feature 029 added three conversations with real channels (FR-024 — the operator asked for three
   * categories to judge the Inbox against), which is a legitimate fixture addition. Pinning the count
   * would have made every future seed addition look like a regression in feature 022.
   */
  it('feature 022: the collision player has BOTH channelled and channel-less conversations', () => {
    const mine = seed.conversations.filter((c) => c.player_id === SEED_PLAYER_ID);
    const named = mine.filter((c) => (c as { channel?: string | null }).channel);
    expect(named.length).toBeGreaterThan(0);
    // The others are the state the whole existing history is in until Phase 6 — the unrecorded bucket.
    expect(mine.length - named.length).toBeGreaterThan(0);
  });

  /**
   * Feature 029 (FR-024) — the operator's three conversations for judging the Inbox.
   *
   * They live in the seed because there is no `POST /conversations` at the REST edge: a conversation
   * is opened by channel ingestion, and Phase 6 owns the channels. Track B tried and got a 404.
   */
  it('feature 029: three conversations with DISTINCT categories and channels exist', () => {
    // ⚠️ Scoped to these three ids, not to "every categorised conversation": an earlier fixture
    // already carries a lowercase `billing` category for another purpose. Asserting over all of them
    // would make this test fail whenever some unrelated feature classifies a row — which is exactly
    // the brittleness that just had to be relaxed one test above.
    const ids = [
      SEED_CONVERSATION_TEST_ID,
      SEED_CONVERSATION_BILLING_ID,
      SEED_CONVERSATION_ACCESS_ID,
    ];
    const mine = seed.conversations.filter((c) => ids.includes(c.id));
    expect(mine).toHaveLength(3);

    const categories = mine.map((c) => (c as { category: string }).category);
    expect(new Set(categories)).toEqual(new Set(['Test', 'Billing', 'Access']));

    const channels = mine.map((c) => (c as { channel?: string | null }).channel);
    expect(new Set(channels).size).toBe(3); // three different channels, so the filter has real work

    // Every one has a human title, so the queue is scannable rather than a column of ids.
    for (const c of mine) expect((c as { subject?: string | null }).subject).toBeTruthy();
  });

  it('feature 029: the `Test` conversation carries a real four-turn exchange', () => {
    const test = seed.conversations.find(
      (c) => (c as { category?: string | null }).category === 'Test',
    )!;
    const thread = seed.messages.filter((m) => m.conversation_id === test.id);
    expect(thread).toHaveLength(4);
    // Customer → agent → customer → agent: a dialogue, not four messages from one side.
    expect(thread.map((m) => m.author_type)).toEqual(['player', 'operator', 'player', 'operator']);
    // …and the derived contact stamps therefore have both directions.
    expect((test as { last_inbound_at: Date | null }).last_inbound_at).not.toBeNull();
    expect((test as { last_outbound_at: Date | null }).last_outbound_at).not.toBeNull();
  });

  it('feature 029: no seeded message carries a contact detail', () => {
    // The subject column is the one place customer-authored text reaches the queue unmasked, so the
    // fixtures must not put an email or a phone number there for a screenshot to leak.
    for (const m of seed.messages) {
      expect(m.body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
      expect(m.body).not.toMatch(/\+\d[\d ()-]{7,}\d/);
    }
  });

  it('includes at least one private (internal) message', () => {
    expect(seed.messages.some((m) => m.private === true)).toBe(true);
  });

  it('links the open conversation to the label', () => {
    expect(seed.conversationLabels.length).toBeGreaterThan(0);
  });

  // ── feature 013 (workflow) fixtures ──
  it('ships an UNASSIGNED conversation so assign/reassign/unassign has a clean start (US1)', () => {
    const unassigned = seed.conversations.find((c) => c.id === SEED_CONVERSATION_UNASSIGNED_ID);
    expect(unassigned).toBeDefined();
    expect(unassigned!.assignee_operator_id).toBeNull();
    // and at least one conversation IS assigned, so reassignment has a fixture too
    expect(seed.conversations.some((c) => c.assignee_operator_id !== null)).toBe(true);
  });

  it('ships a second label so attach has a target that is not already linked (US2)', () => {
    expect(seed.labels.length).toBeGreaterThanOrEqual(2);
    const linked = new Set(seed.conversationLabels.map((l) => l.label_id));
    expect(seed.labels.some((l) => !linked.has(l.id))).toBe(true);
  });

  it('ships two macros: one self-contained, one containing ASSIGN (the all-or-nothing fixture)', () => {
    const actionsOf = (id: string) =>
      (seed.macros.find((m) => m.id === id)!.definition as { actions: { type: string }[] }).actions;

    const plain = actionsOf(SEED_MACRO_ID).map((a) => a.type);
    expect(plain).toEqual([
      'MACRO_ACTION_TYPE_SET_STATUS',
      'MACRO_ACTION_TYPE_ADD_LABEL',
    ]);

    const withAssign = actionsOf(SEED_MACRO_ASSIGN_ID).map((a) => a.type);
    expect(withAssign).toContain('MACRO_ACTION_TYPE_ASSIGN');
  });

  it('every macro action carries a non-empty value and a prefixed wire type (R4)', () => {
    for (const macro of seed.macros) {
      const { actions } = macro.definition as { actions: { type: string; value: string }[] };
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) {
        expect(a.type.startsWith('MACRO_ACTION_TYPE_')).toBe(true);
        expect(a.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('ships a canned response with text only — no conversation or message link (FR-009)', () => {
    expect(seed.cannedResponses.length).toBeGreaterThan(0);
    for (const c of seed.cannedResponses) {
      expect(c.body.length).toBeGreaterThan(0);
      expect(Object.keys(c)).toEqual(
        expect.not.arrayContaining(['conversation_id', 'message_id', 'player_id']),
      );
    }
  });
});

/**
 * T030 (feature 014) — the automation + SLA fixtures. FAILS before the seed delta, PASSES after.
 *
 * These fixtures exist so Track B can prove behaviour that no mocked test can: a rule firing with no
 * operator present, and a breach detected by a timer. So the assertions here are about the fixtures
 * being *usable for that purpose* — every definition must be valid, each rule must have the exact
 * shape its scenario needs, and the ones that mutate shared state must ship DISABLED so a leftover
 * enabled rule from a previous run cannot masquerade as a product defect.
 */
describe('chats seed — feature 014 (automations + first-reply SLA)', () => {
  const seed = buildSeed();
  const rule = (id: string) => seed.automations.find((a) => a.id === id)!;
  const defOf = (id: string) =>
    rule(id).definition as {
      trigger: string;
      conditions: { field: string; op: string; value: string }[];
      actions: { type: string; value: string }[];
    };

  it('ships the four scenario rules', () => {
    expect(seed.automations.map((a) => a.id).sort()).toEqual(
      [
        SEED_AUTOMATION_KEYWORD_ID,
        SEED_AUTOMATION_ASSIGN_ID,
        SEED_AUTOMATION_SELF_ID,
        SEED_AUTOMATION_BREACH_ID,
      ].sort(),
    );
  });

  it('every rule names an author — a rule with no authority could only ever be refused (FR-024)', () => {
    for (const r of seed.automations) expect(r.author_user_id.length).toBeGreaterThan(0);
  });

  it('every definition is well formed: a known trigger, a non-empty action list, prefixed wire values', () => {
    for (const r of seed.automations) {
      const d = r.definition as { trigger: string; actions: { type: string; value: string }[] };
      expect(d.trigger.startsWith('AUTOMATION_TRIGGER_')).toBe(true);
      expect(d.trigger).not.toBe('AUTOMATION_TRIGGER_UNSPECIFIED');
      expect(d.actions.length).toBeGreaterThan(0);
      for (const a of d.actions) {
        expect(a.type.startsWith('MACRO_ACTION_TYPE_')).toBe(true);
        expect(a.value.length).toBeGreaterThan(0);
      }
    }
  });

  it('the keyword rule matches message text AND requires an unassigned conversation', () => {
    const d = defOf(SEED_AUTOMATION_KEYWORD_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_MESSAGE_RECEIVED');
    expect(d.conditions.map((c) => c.field).sort()).toEqual(
      ['CONDITION_FIELD_ASSIGNEE', 'CONDITION_FIELD_MESSAGE_TEXT'].sort(),
    );
    expect(d.conditions.find((c) => c.field === 'CONDITION_FIELD_MESSAGE_TEXT')!.value).toBe(
      SEED_AUTOMATION_KEYWORD,
    );
    expect(rule(SEED_AUTOMATION_KEYWORD_ID).active).toBe(true);
  });

  it('the ASSIGN rule is the permission-refusal fixture and ships DISABLED', () => {
    expect(defOf(SEED_AUTOMATION_ASSIGN_ID).actions.map((a) => a.type)).toContain(
      'MACRO_ACTION_TYPE_ASSIGN',
    );
    expect(rule(SEED_AUTOMATION_ASSIGN_ID).active).toBe(false);
  });

  it('the self-satisfying rule really is self-satisfying (and ships DISABLED)', () => {
    const d = defOf(SEED_AUTOMATION_SELF_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_STATUS_CHANGED');
    // Its own action re-satisfies its own trigger — the worst case for SC-004, on purpose.
    expect(d.actions.map((a) => a.type)).toEqual(['MACRO_ACTION_TYPE_SET_STATUS']);
    expect(rule(SEED_AUTOMATION_SELF_ID).active).toBe(false);
  });

  it('the breach rule reacts to a missed target with a label + a priority raise', () => {
    const d = defOf(SEED_AUTOMATION_BREACH_ID);
    expect(d.trigger).toBe('AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED');
    expect(d.actions.map((a) => a.type).sort()).toEqual(
      ['MACRO_ACTION_TYPE_ADD_LABEL', 'MACRO_ACTION_TYPE_SET_PRIORITY'].sort(),
    );
    expect(rule(SEED_AUTOMATION_BREACH_ID).active).toBe(true);
  });

  it('rules reference labels that the seed actually creates (else they would refuse at run time)', () => {
    const labelIds = new Set(seed.labels.map((l) => l.id));
    for (const r of seed.automations) {
      const d = r.definition as { actions: { type: string; value: string }[] };
      for (const a of d.actions) {
        if (a.type === 'MACRO_ACTION_TYPE_ADD_LABEL') expect(labelIds.has(a.value)).toBe(true);
      }
    }
  });

  it('ships ONE account-level SLA target using the "*" sentinels, not NULLs (research R7)', () => {
    expect(seed.slaPolicies).toHaveLength(1);
    const p = seed.slaPolicies[0]!;
    expect(p.scope_priority).toBe('*');
    expect(p.scope_brand_id).toBe('*');
    expect(p.target_minutes).toBeGreaterThan(0);
  });

  it('ships an SLA conversation with NO messages, so its clock starts from a known state', () => {
    const conv = seed.conversations.find((c) => c.id === SEED_CONVERSATION_SLA_ID);
    expect(conv).toBeDefined();
    expect(conv!.assignee_operator_id).toBeNull();
    expect(seed.messages.some((m) => m.conversation_id === SEED_CONVERSATION_SLA_ID)).toBe(false);
  });
});

/**
 * Feature 022 (roadmap 4.13), T017 — **the fixtures carry contact stamps, and they agree with the
 * fixture messages.**
 *
 * `seed.ts` writes messages with `upsert`, bypassing the repository that maintains the stamps
 * (research R3), so the builder derives them. Track B runs on this seed: unstamped fixtures would make
 * the live run report a product defect that is really a fixture defect.
 *
 * The property asserted here is the same one `migration-022.spec.ts` asserts for the backfill and Track B
 * asserts for live rows: **what the columns say is what the messages say.**
 */
describe('chats seed builder — contact stamps (feature 022)', () => {
  const seed = buildSeed();
  const conv = (id: string) => seed.conversations.find((c) => c.id === id)!;

  it('every conversation carries both stamp fields (present, even when null)', () => {
    // A missing FIELD and a null VALUE are different: the first means the derivation skipped a fixture,
    // which would ship as "never contacted" for that card.
    for (const c of seed.conversations) {
      expect(Object.keys(c)).toContain('last_inbound_at');
      expect(Object.keys(c)).toContain('last_outbound_at');
    }
  });

  it('the stamps equal the derivation over that conversation’s own messages', () => {
    for (const c of seed.conversations) {
      const mine = seed.messages.filter((m) => m.conversation_id === c.id);
      const maxOf = (pick: (m: (typeof mine)[number]) => boolean) => {
        const times = mine.filter(pick).map((m) => m.created_at.getTime());
        return times.length ? new Date(Math.max(...times)) : null;
      };
      expect({ id: c.id, inbound: c.last_inbound_at, outbound: c.last_outbound_at }).toEqual({
        id: c.id,
        inbound: maxOf((m) => m.author_type === 'player' && !m.private),
        outbound: maxOf((m) => m.author_type === 'operator' && !m.private),
      });
    }
  });

  it('the private note does NOT become the last outbound contact, though it is the latest message', () => {
    // The fixture is built so this mistake changes a value rather than changing nothing: the note is
    // 09:30, the public reply 09:15. A card reading 09:30 would be reporting a staff-only note as a
    // conversation with the customer.
    const c = conv(SEED_CONVERSATION_OPEN_ID);
    const note = seed.messages.find((m) => m.private)!;
    expect(c.last_outbound_at).toEqual(SEED_MESSAGE_REPLY_AT);
    expect(note.created_at.getTime()).toBeGreaterThan(SEED_MESSAGE_REPLY_AT.getTime());
    expect(c.last_outbound_at).not.toEqual(note.created_at);
  });

  it('a conversation with no messages has BOTH stamps null (never contacted, not an error)', () => {
    const c = conv(SEED_CONVERSATION_SLA_ID);
    expect(c.last_inbound_at).toBeNull();
    expect(c.last_outbound_at).toBeNull();
  });

  it('message timestamps are FIXED, so Track B can compare a stored value with an API value', () => {
    // With `now()` at seed time the live comparison would be a coin toss, and the two halves of Track
    // B's equality assertion (a backfilled row and a freshly written one) could not both be pinned.
    for (const m of seed.messages) expect(m.created_at).toBeInstanceOf(Date);
    expect(conv(SEED_CONVERSATION_OPEN_ID).last_inbound_at).toEqual(SEED_MESSAGE_PLAYER_AT);
  });

  it('the derivation helper is reusable and handles a system entry as inert', () => {
    // Exercises the helper directly, so the rule's own edge cases are pinned here too — the Track-B
    // fixtures added later (a system message, a channel-less conversation) go through this same path.
    const out = deriveContactStamps(
      [{ id: 'c-x' }],
      [
        { conversation_id: 'c-x', author_type: 'system', created_at: new Date('2026-07-21T10:00:00Z') },
        { conversation_id: 'c-x', author_type: 'player', created_at: new Date('2026-07-21T09:00:00Z') },
        { conversation_id: 'c-other', author_type: 'player', created_at: new Date('2026-07-22T09:00:00Z') },
      ],
    );
    expect(out[0]!.last_inbound_at).toEqual(new Date('2026-07-21T09:00:00Z'));
    expect(out[0]!.last_outbound_at).toBeNull(); // a system entry stamps nothing
  });
});


/**
 * T017 / T023 (feature 032, roadmap 4.16 — ADR 0040) — the seeded status catalogue, and the fixtures that
 * now use it.
 *
 * ⚠️ The load-bearing assertion is the LAST one: every conversation names a status the seed configures. It
 * is the same claim the composite foreign key makes in the database, asserted where a developer meets it
 * first — a fixture that named an unconfigured status would otherwise fail at `prisma migrate`/seed time
 * on a constraint, which reads as a broken migration rather than as a broken fixture.
 */
describe('chats seed — feature 032 (status categories)', () => {
  const seed = buildSeed();

  it('seeds the nine statuses, all in the seed account, each in a real category', () => {
    expect(seed.statuses).toHaveLength(9);
    for (const st of seed.statuses) {
      expect(st.account_id).toBe(SEED_ACCOUNT_ID);
      expect(isStatusCategory(st.category)).toBe(true);
      expect(st.agent_name.length).toBeGreaterThan(0);
      expect(st.end_user_name.length).toBeGreaterThan(0);
      expect(st.active).toBe(true);
    }
  });

  it('is built FROM the shared set — so the seed and the SQL migration cannot disagree', () => {
    expect(seed.statuses.map((s) => s.key)).toEqual(SEEDED_STATUSES.map((s) => s.key));
  });

  it('⭐ idempotent by KEY: the ids are derived from the key, so re-seeding leaves nine, not eighteen', () => {
    // `seed.ts` upserts on `(account_id, key)`. A random or sequential id would make a second run insert a
    // parallel set — the shape the W1 live round found in `Credential`, one table over.
    const ids = seed.statuses.map((s) => s.id);
    expect(new Set(ids).size).toBe(9);
    for (const st of seed.statuses) {
      expect(st.id).toBe(`seed-status-${st.key}`);
    }
    expect(buildSeed().statuses).toEqual(seed.statuses);
  });

  it('⭐ EVERY conversation names a status the seed configures (the FK, asserted here first)', () => {
    const configured = new Set(seed.statuses.map((s) => s.key));
    for (const conv of seed.conversations) {
      expect({ id: conv.id, status: conv.status, configured: configured.has(conv.status) }).toEqual({
        id: conv.id,
        status: conv.status,
        configured: true,
      });
    }
  });

  it('⚠️ the retired words are GONE from the fixtures (`resolved` → `solved`, `snoozed` → `pending`)', () => {
    const statuses = seed.conversations.map((c) => c.status);
    expect(statuses).not.toContain('resolved');
    expect(statuses).not.toContain('snoozed');
    expect(statuses).toContain('solved');
  });

  it('⭐ two fixtures use statuses the flat enum could not express — so the screen has them to show', () => {
    const statuses = seed.conversations.map((c) => c.status);
    expect(statuses).toContain('vip_pending');
    expect(statuses).toContain('in_progress');
  });

  it('the in_progress fixture is NON-terminal and assigned — the load counter must see it', () => {
    const conv = seed.conversations.find((c) => c.status === 'in_progress')!;
    const def = seed.statuses.find((s) => s.key === 'in_progress')!;
    expect(NON_TERMINAL_CATEGORIES).toContain(def.category);
    expect(conv.assignee_operator_id).toBeTruthy();
  });

  it('⚠️ no stored macro or automation still names a proto enum member', () => {
    const stored = JSON.stringify([seed.macros, seed.automations]);
    expect(stored).not.toContain('CONVERSATION_STATUS_');
    // …and the SET_STATUS values that remain are configured keys.
    const configured = new Set(seed.statuses.map((s) => s.key));
    for (const match of stored.matchAll(/"MACRO_ACTION_TYPE_SET_STATUS","value":"([^"]+)"/g)) {
      expect(configured.has(match[1]!)).toBe(true);
    }
  });
});
