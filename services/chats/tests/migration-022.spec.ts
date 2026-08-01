import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');
const MIGRATION = join(
  ROOT,
  'services',
  'chats',
  'prisma',
  'migrations',
  '20260803000000_conversation_contact_stamps',
  'migration.sql',
);
const RULE = join(ROOT, 'services', 'chats', 'src', 'message', 'contact-stamp.ts');
const SCHEMA = join(ROOT, 'services', 'chats', 'prisma', 'schema.prisma');

const sql = () => readFileSync(MIGRATION, 'utf8');

/**
 * Feature 022 (roadmap 4.13), T012 — **the migration and the backfill, proved as text.**
 *
 * Track A has no database (the fakes in `src/**` deliberately apply the filters so the tests prove the
 * scoping and not the fake), so what is provable HERE is the SQL itself. The behavioural equality
 * — "the stored columns equal what the messages say" — is Track B's job, against a real planner and
 * real rows, for both a backfilled conversation and one written after the migration.
 *
 * What this file protects is the seam most likely to rot: the derivation rule exists **twice** by
 * necessity — once in TypeScript for new messages, once in SQL for the existing 372K-row history — and
 * nothing but a test can keep the two saying the same thing.
 */
describe('T012 — the contact-stamp migration exists and adds both columns nullable', () => {
  it('the migration file is present (a schema change with no migration is a Track-B surprise)', () => {
    expect(sql().length).toBeGreaterThan(0);
  });

  it('both columns are added, and NEITHER is NOT NULL', () => {
    const body = sql();
    expect(body).toMatch(/ADD COLUMN "last_inbound_at"\s+TIMESTAMP\(3\)/i);
    expect(body).toMatch(/ADD COLUMN "last_outbound_at"\s+TIMESTAMP\(3\)/i);
    // NULL is the meaningful "never happened" state (a conversation whose only message is a private
    // note). A NOT NULL default would turn that into a real timestamp — an epoch date on a card.
    expect(body).not.toMatch(/last_(inbound|outbound)_at"?\s+TIMESTAMP\(3\)\s+NOT NULL/i);
    expect(body).not.toMatch(/last_(inbound|outbound)_at"?\s+TIMESTAMP\(3\)\s+DEFAULT/i);
  });

  it('the schema declares them optional too, so Prisma and Postgres agree', () => {
    const schema = readFileSync(SCHEMA, 'utf8');
    expect(schema).toMatch(/last_inbound_at\s+DateTime\?/);
    expect(schema).toMatch(/last_outbound_at\s+DateTime\?/);
  });

  it('no index is created on either column (they are aggregated, never filtered on)', () => {
    // An index here would add write cost on the busiest path in the product for no read. Pinned so the
    // next person optimising a slow card adds it deliberately, with a measurement.
    expect(sql()).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX[^;]*last_(inbound|outbound)_at/i);
  });
});

describe('T012 — the backfill is present, and its rule is the SAME rule the code applies', () => {
  it('existing rows are backfilled (a NULL history would report "never contacted" for everyone)', () => {
    const body = sql();
    expect(body).toMatch(/UPDATE\s+"Conversation"/i);
    expect(body).toMatch(/FROM\s+"Message"/i);
    expect(body).toMatch(/GROUP BY\s+"conversation_id"/i);
  });

  it('inbound is MAX(created_at) over player-authored messages', () => {
    expect(sql()).toMatch(
      /MAX\("created_at"\)\s+FILTER\s+\(WHERE\s+"author_type"\s*=\s*'player'\)\s+AS\s+"last_inbound_at"/i,
    );
  });

  it('outbound is MAX(created_at) over operator messages that are NOT private', () => {
    expect(sql()).toMatch(
      /MAX\("created_at"\)\s+FILTER\s+\(WHERE\s+"author_type"\s*=\s*'operator'\s+AND\s+"private"\s*=\s*false\)\s+AS\s+"last_outbound_at"/i,
    );
  });

  it('the backfill agrees with contact-stamp.ts on all four cases', () => {
    // The load-bearing assertion of this file. The rule lives in two languages because it has to; the
    // failure mode is one of them changing alone, and the symptom would be historical rows disagreeing
    // with new ones — visible on a card, invisible in a diff.
    const rule = readFileSync(RULE, 'utf8');
    const body = sql();

    // player → inbound, in both places
    expect(rule).toMatch(/authorType === 'player'/);
    expect(body).toMatch(/"author_type"\s*=\s*'player'/i);

    // operator + NOT private → outbound, in both places
    expect(rule).toMatch(/authorType === 'operator'/);
    expect(rule).toMatch(/isPrivate \? null : 'last_outbound_at'/);
    expect(body).toMatch(/"author_type"\s*=\s*'operator'\s+AND\s+"private"\s*=\s*false/i);

    // system → nothing: it must appear in NO filter. `return null` covers it in the code.
    expect(body).not.toMatch(/"author_type"\s*=\s*'system'/i);

    // a private note → nothing: no filter may select `private = true`.
    expect(body).not.toMatch(/"private"\s*=\s*true/i);
  });

  it('the backfill touches only the two new columns', () => {
    // A migration that also rewrote `updated_at` would silently re-date the whole history — and
    // `updated_at` is the very column this feature exists to stop trusting.
    const setClause = /SET([\s\S]*?)FROM \(/i.exec(sql())?.[1] ?? '';
    expect(setClause).toMatch(/last_inbound_at/);
    expect(setClause).toMatch(/last_outbound_at/);
    expect(setClause).not.toMatch(/updated_at|created_at\s*=/);
  });
});
