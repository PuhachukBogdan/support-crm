import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SEEDED_STATUSES, LEGACY_STATUS_MIGRATION, LEGACY_STATUS_WIRE_MIGRATION } from '../../libs/common/src';

/**
 * T022 (feature 032, roadmap 4.16 — ADR 0040 §5) — **the migration leaves no row unmapped.**
 *
 * ── Why a structural read of the SQL and not a live check ─────────────────────────────────────────
 * The live round proves it ran; this proves it is COMPLETE before anyone runs it. A migration is the one
 * change that cannot be corrected by a redeploy: a status word left behind becomes a conversation whose
 * status resolves to nothing, and the composite foreign key then refuses the very migration meant to fix
 * it. So the mapping is asserted against the shared constants the seed also builds from — one definition,
 * three consumers (this SQL, the seed, these tests), and no way for two of them to disagree quietly.
 *
 * ⚠️ This does NOT re-check what the SQL means. It checks that every fact the ADR decided is PRESENT and
 * that the five steps are in the order the constraint requires. `deploy/local/live-w2.sh` runs it for real.
 */
const ROOT = resolve(__dirname, '..', '..');
const SQL = readFileSync(
  join(
    ROOT,
    'services',
    'chats',
    'prisma',
    'migrations',
    '20260809000000_status_categories',
    'migration.sql',
  ),
  'utf8',
);

describe('the scan found the migration (nothing below can pass vacuously)', () => {
  it('reads a substantial file that creates the table and adds the constraint', () => {
    expect(SQL.length).toBeGreaterThan(1500);
    expect(SQL).toContain('CREATE TABLE "ConversationStatus"');
    expect(SQL).toContain('ADD CONSTRAINT "Conversation_account_id_status_fkey"');
  });
});

describe('*** the table can hold the model ADR 0040 describes ***', () => {
  it.each(['key', 'category', 'agent_name', 'end_user_name', 'active', 'order'])(
    'declares the column `%s`',
    (column) => {
      expect(SQL).toContain(`"${column}"`);
    },
  );

  it('the key is unique per ACCOUNT — one tenant’s vocabulary cannot be another’s', () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX "ConversationStatus_account_id_key_key"[\s\S]*?\("account_id",\s*"key"\)/,
    );
  });

  it('the catalogue read is indexed on (account, active, order)', () => {
    expect(SQL).toMatch(/CREATE INDEX[\s\S]*?\("account_id",\s*"active",\s*"order"\)/);
  });
});

describe('*** every seeded status is backfilled, for every account already in the database ***', () => {
  it.each(SEEDED_STATUSES.map((s) => s.key))('inserts `%s`', (key) => {
    expect(SQL).toContain(`'${key}'`);
  });

  it('each status carries its category and BOTH names', () => {
    for (const s of SEEDED_STATUSES) {
      // The VALUES row for this key must mention its category and both display names.
      const row = new RegExp(`'${s.key}'[^\\n]*`).exec(SQL)?.[0] ?? '';
      expect(row).toContain(`'${s.category}'`);
      expect(row).toContain(s.agentName);
      expect(row).toContain(s.endUserName);
    }
  });

  it('⚠️ the account list is the UNION of all three tables that can name one', () => {
    // An account whose macros exist but whose first ticket has not arrived still needs a vocabulary, or
    // the rule it authored cannot be validated.
    for (const table of ['"Conversation"', '"Macro"', '"Automation"']) {
      expect(SQL).toMatch(new RegExp(`SELECT DISTINCT "account_id" FROM ${table}`));
    }
  });

  it('re-running is safe — the insert is ON CONFLICT DO NOTHING', () => {
    expect(SQL).toMatch(/ON CONFLICT \("account_id", "key"\) DO NOTHING/);
  });
});

describe('*** the four shipped values migrate, and NOTHING is left unmapped ***', () => {
  it('remaps the two words that change (`resolved` → `solved`, `snoozed` → `pending`)', () => {
    expect(SQL).toMatch(/UPDATE "Conversation" SET "status" = 'solved'\s+WHERE "status" = 'resolved'/);
    expect(SQL).toMatch(/UPDATE "Conversation" SET "status" = 'pending' WHERE "status" = 'snoozed'/);
  });

  it('every target of the shared migration map is a status the SQL actually creates', () => {
    const created = SEEDED_STATUSES.map((s) => s.key);
    for (const target of Object.values(LEGACY_STATUS_MIGRATION)) {
      expect(created).toContain(target);
    }
  });

  it('⭐ a value NO release ever wrote still lands somewhere — the catch-all is the "no unmapped row" half', () => {
    // Without this, an unrecognised status would survive the remaps and then be refused by the foreign
    // key, failing the deployment on a row nobody can name. `open` is the honest destination: it is the
    // state a ticket in an unknown status actually needs.
    expect(SQL).toMatch(/UPDATE "Conversation" SET "status" = 'open'\s+WHERE "status" NOT IN \(/);
    for (const key of SEEDED_STATUSES.map((s) => s.key)) {
      expect(SQL).toMatch(new RegExp(`NOT IN \\([^)]*'${key}'`));
    }
  });

  it('⚠️ the two JSON columns are rewritten too — a stored rule must not name a dead vocabulary', () => {
    for (const table of ['"Macro"', '"Automation"']) {
      expect(SQL).toMatch(new RegExp(`UPDATE ${table}\\s+SET "definition" = replace\\(`));
    }
    for (const [wire, key] of Object.entries(LEGACY_STATUS_WIRE_MIGRATION)) {
      // Whitespace-tolerant: the SQL aligns these pairs into columns for readability.
      expect(SQL).toMatch(new RegExp(`'${wire}',\\s*'${key}'`));
    }
  });
});

describe('*** the ORDER of the steps is the migration ***', () => {
  it('⭐ the foreign key is added LAST — it cannot exist while an unmapped row does', () => {
    const remap = SQL.indexOf(`SET "status" = 'solved'`);
    const jsonRewrite = SQL.indexOf('UPDATE "Macro"');
    const constraint = SQL.indexOf('ADD CONSTRAINT "Conversation_account_id_status_fkey"');
    const backfill = SQL.indexOf('INSERT INTO "ConversationStatus"');
    const create = SQL.indexOf('CREATE TABLE "ConversationStatus"');

    expect(create).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(remap);
    expect(remap).toBeLessThan(constraint);
    expect(jsonRewrite).toBeLessThan(constraint);
  });

  it('the constraint restricts deletes and cascades renames', () => {
    // Retirement is `active = false`; a status in use must not be removable. A rename is one statement
    // rather than a rewrite of history.
    expect(SQL).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
  });
});
