import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHANNEL_KINDS, channelKindFromStored } from '../../libs/common/src';

/**
 * T014 + T024 + T036/T059's structural halves (feature 033) — **the migration is complete, and the three
 * constraints the feature stands on exist.**
 *
 * ── Why a structural read of the SQL and not a live check ─────────────────────────────────────────
 * The same reasoning feature 032 recorded: the live round (`live-w3.sh`) proves it RAN; this proves it is
 * complete before anybody runs it. A migration is the one change a redeploy cannot correct — and this one
 * rewrites values on the largest table in the system.
 *
 * ── The three constraints are asserted HERE rather than trusted ───────────────────────────────────
 * Each is a place where correctness is delegated to the database on purpose (FR-013/FR-032/FR-036), which
 * means a later edit could remove one and every unit test would still pass:
 *
 *   • `ChannelIntake(channel_id, external_event_id)` — at-most-once intake. Without it, a provider's retry
 *     racing its own first delivery creates a second ticket.
 *   • `Message(account_id, external_id)` — one copy per inbound email.
 *   • `OutboundMessage(message_id)` — one delivery per reply. Without it a retried request sends twice,
 *     and a second copy to a customer cannot be recalled.
 */
const ROOT = resolve(__dirname, '..', '..');
const CHATS_SQL = readFileSync(
  join(
    ROOT,
    'services',
    'chats',
    'prisma',
    'migrations',
    '20260810000000_channels_intake_delivery',
    'migration.sql',
  ),
  'utf8',
);
const USERS_SQL = readFileSync(
  join(
    ROOT,
    'services',
    'users',
    'prisma',
    'migrations',
    '20260810000000_channel_participant',
    'migration.sql',
  ),
  'utf8',
);

/**
 * The SQL with `--` comments stripped: the executable statements only.
 *
 * Needed because two assertions below are NEGATIVE ("this column is not created", "no address column
 * exists"), and a migration that explains in prose why it avoids something would fail a scan of the prose.
 * Deleting the explanation to satisfy the scan is the trade this project has refused before.
 */
const STATEMENTS = CHATS_SQL.replace(/^\s*--.*$/gm, '');

describe('the scan found the migrations (nothing below can pass vacuously)', () => {
  it('reads two substantial files', () => {
    expect(CHATS_SQL.length).toBeGreaterThan(2000);
    expect(USERS_SQL.length).toBeGreaterThan(500);
    expect(CHATS_SQL).toContain('CREATE TABLE "Channel"');
    expect(USERS_SQL).toContain('CREATE TABLE "ChannelParticipant"');
  });
});

describe('*** the three constraints correctness is delegated to ***', () => {
  it('at-most-once intake: unique (channel_id, external_event_id)', () => {
    expect(CHATS_SQL).toMatch(
      /CREATE UNIQUE INDEX "ChannelIntake_channel_id_external_event_id_key"[\s\S]*?"channel_id", "external_event_id"/,
    );
  });

  it('one copy per inbound email: unique (account_id, external_id) on Message', () => {
    expect(CHATS_SQL).toMatch(
      /CREATE UNIQUE INDEX "Message_account_id_external_id_key"[\s\S]*?"account_id", "external_id"/,
    );
  });

  it('one delivery per reply: unique (message_id) on OutboundMessage', () => {
    expect(CHATS_SQL).toMatch(/CREATE UNIQUE INDEX "OutboundMessage_message_id_key"/);
  });

  it('the claim query is indexed in its exact shape', () => {
    // `status = 'pending' AND next_attempt_at <= now`, oldest first. Without the index this is a scan of
    // the outbox on every tick — cheap while the queue is empty and quadratic on the day it is not.
    expect(CHATS_SQL).toMatch(
      /CREATE INDEX "OutboundMessage_status_next_attempt_at_idx"[\s\S]*?"status", "next_attempt_at"/,
    );
  });

  it("W9's queue is indexed: (account_id, identity_state)", () => {
    expect(CHATS_SQL).toMatch(/CREATE INDEX "Conversation_account_id_identity_state_idx"/);
  });
});

describe('*** the arrival channel is typed IN PLACE ***', () => {
  it('folds the retired `chat` value into `api`', () => {
    // The widget chat IS the API channel (roadmap 6.1). One vocabulary, not two words for one transport.
    expect(CHATS_SQL).toMatch(/UPDATE "Conversation" SET "channel" = 'api'\s+WHERE "channel" = 'chat'/);
  });

  it('⭐ NEVER touches NULL — an absence is not a fourth kind', () => {
    // About one in six rows are NULL, and the 029 Inbox filter depends on them staying reachable. A
    // migration that filled them with an invented `internal` kind would be a lie in the data, and would
    // break the filter contract that says a `channel: null` predicate must never exist.
    //
    // Asserted as the ABSENCE of any write to a NULL channel: every UPDATE in this file is guarded by a
    // predicate that excludes NULL.
    const updates = CHATS_SQL.match(/UPDATE "Conversation" SET "channel"[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u).toMatch(/WHERE "channel" (=|IS NOT NULL)/);
    }
    expect(CHATS_SQL).not.toMatch(/WHERE "channel" IS NULL/);
  });

  it('leaves no value the vocabulary cannot resolve', () => {
    // Anything unexpected — a hand-written INSERT, a value from a branch that never shipped — becomes
    // NULL rather than a guess. A word the vocabulary cannot resolve is worse than no word: the filter
    // cannot offer it and the analytics split cannot bucket it.
    expect(CHATS_SQL).toMatch(
      /UPDATE "Conversation" SET "channel" = NULL\s+WHERE "channel" IS NOT NULL AND "channel" NOT IN \('api', 'email', 'messenger'\)/,
    );
  });

  it('the target vocabulary in the SQL is exactly the catalogue in code', () => {
    // The one place this SQL and `libs/common` could drift. Pinned so adding a kind is a deliberate edit
    // in both, rather than a migration that silently nulls a kind the product now supports.
    const inSql = CHATS_SQL.match(/NOT IN \(([^)]+)\)/)?.[1] ?? '';
    for (const kind of CHANNEL_KINDS) {
      expect(inSql).toContain(`'${kind}'`);
    }
  });

  it('⚠️ NO `channel_kind` column is created', () => {
    // `mvp-plan.md` and the spec name the concept `channel_kind`; the column stays `channel` so the wire
    // is unchanged. Two columns for one fact would be two sources of truth, and the loser is whichever
    // the next reader did not notice.
    //
    // ⚠️ Checked against the STATEMENTS, not the file: the migration's own header explains why the column
    // does not exist, and a scan over prose is satisfied by deleting the explanation. That is the failure
    // `no-status-key-branch.spec.ts` names, and it caught this test on its first run.
    expect(STATEMENTS).not.toContain('channel_kind');
  });
});

describe('*** the five new columns are all nullable — no backfill, no rewrite ***', () => {
  it.each([
    ['Conversation', 'identity_state'],
    ['Conversation', 'channel_participant_id'],
    ['Conversation', 'continues_conversation_id'],
    ['Message', 'external_id'],
  ])('%s.%s is added without NOT NULL', (table, column) => {
    const stmt = new RegExp(`ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT;`);
    expect(CHATS_SQL).toMatch(stmt);
  });
});

describe('*** the envelope lives in users, and chats holds a handle ***', () => {
  it('users stores the address; chats stores no address column at all', () => {
    expect(USERS_SQL).toContain('"address" TEXT NOT NULL');
    // The load-bearing negative. `ContactMatch`'s own comment names what a column here would create: a
    // PII surface the tier policy does not classify, masking does not cover and exports do not know about.
    expect(CHATS_SQL).not.toMatch(/ALTER TABLE "Conversation" ADD COLUMN "[a-z_]*address/i);
    expect(CHATS_SQL).not.toMatch(/ALTER TABLE "Message" ADD COLUMN "[a-z_]*address/i);
    expect(CHATS_SQL).not.toMatch(/"(to_email|from_email|recipient|reply_to)"/i);
  });

  it('a returning customer reuses one participant row per brand', () => {
    expect(USERS_SQL).toMatch(
      /CREATE UNIQUE INDEX "ChannelParticipant_account_id_brand_id_kind_address_key"/,
    );
  });
});

describe('the vocabulary helper agrees with what the migration leaves behind', () => {
  it('every value the migration can leave resolves, and nothing else does', () => {
    // After the migration a stored channel is one of the three kinds, or NULL. This is the contract the
    // rest of the product reads through, so it is worth stating in the same file as the migration.
    for (const kind of CHANNEL_KINDS) expect(channelKindFromStored(kind)).toBe(kind);
    expect(channelKindFromStored(null)).toBeUndefined();
    // `chat` no longer exists in the data; if one appeared, it must read as a DEFECT, not as an absence.
    expect(channelKindFromStored('chat')).toBeNull();
  });
});
