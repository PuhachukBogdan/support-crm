import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T030–T033 [US3] (feature 020) — the migration, asserted as properties of the SQL itself.
 *
 * ── Why a structural spec and not an integration test ───────────────────────────────────────────
 * The migration was **executed** during development against a clone of the live `users_db`: the abort
 * fired on a row with no brand edge, and three consecutive runs finished clean. That is the real
 * verification and it is recorded in `quickstart.md`. What a Jest spec can add is the thing a one-off
 * execution cannot: a guarantee that the properties which made it safe are still in the file next
 * month, when someone edits it.
 *
 * Each detector below is proved against a known-bad sample first. A structural scan that never
 * demonstrates a positive is indistinguishable from one that matches nothing — this repository has
 * found six of those, so the discipline is not optional here.
 */

const MIGRATIONS = join(__dirname, '..', 'prisma', 'migrations');
const DIR = readdirSync(MIGRATIONS).find((d) => d.includes('brand_scoped_player_identity'));

describe('the scan reads the real migration', () => {
  it('the feature-020 migration exists and is not empty', () => {
    expect(DIR).toBeDefined();
    expect(sql().length).toBeGreaterThan(500);
  });
});

function sql(): string {
  return readFileSync(join(MIGRATIONS, DIR!, 'migration.sql'), 'utf8');
}

/** Strip comments: prose describing a guard must not read as the guard. */
function code(): string {
  return sql().replace(/^--.*$/gm, '');
}

describe('T032 — it ABORTS rather than guessing', () => {
  const ABORT = /RAISE\s+EXCEPTION/i;

  it('the detector fires on a real abort and not on prose', () => {
    // The detector is the PIPELINE — strip comments, then match — not the regex alone. Testing the
    // regex by itself would have "proved" a detector that happily matches a sentence in a comment,
    // which is the failure this whole self-check exists to rule out. Caught by running it.
    const strip = (text: string) => text.replace(/^--.*$/gm, '');
    expect(ABORT.test(strip("RAISE EXCEPTION 'nope';"))).toBe(true);
    expect(ABORT.test(strip('-- we would raise exception here'))).toBe(false);
  });

  it('a player with zero or several brand edges stops the migration', () => {
    const body = code();
    expect(ABORT.test(body)).toBe(true);
    // The condition is "not exactly one edge" — both directions, not just the empty case.
    expect(body).toMatch(/HAVING\s+count\([^)]*\)\s*<>\s*1/i);
  });

  it('the failure reports a COUNT and never an identifier', () => {
    // A player id identifies a customer, and a migration error lands in a deploy log (SEC-26).
    const message = /RAISE\s+EXCEPTION[\s\S]{0,400}?;/i.exec(code())?.[0] ?? '';
    expect(message).toContain('%');
    expect(message).toMatch(/ambiguous_count/);
    expect(message).not.toMatch(/player_id\s*\|\||\|\|\s*p\."player_id"/);
  });
});

describe('T030 — a reference resolves by the referring record’s OWN brand', () => {
  it('the derivation reads the edge, never a default or a first-match', () => {
    const body = code();
    expect(body).toMatch(/SET\s+"brand_id"\s*=\s*pb\."brand_id"/i);
    // No LIMIT 1, no MIN/MAX, no COALESCE to a fallback — each of those is a way of picking one.
    expect(body).not.toMatch(/LIMIT\s+1/i);
    expect(body).not.toMatch(/COALESCE\s*\(\s*pb\."brand_id"/i);
    expect(body).not.toMatch(/\b(MIN|MAX)\s*\(\s*pb\."brand_id"/i);
  });

  it('conversations need no migration — the pair is already stored', () => {
    // `Conversation` has carried `brand_id` next to `player_id` since feature 012, so every existing
    // reference is already brand-qualified. Nothing to move; the repair was the key and the query.
    // This test states that on purpose: a reader looking for the chats half should find the reason
    // it is absent rather than assume it was forgotten.
    const chatsSchema = readFileSync(
      join(__dirname, '..', '..', 'chats', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const conversation = /model Conversation \{([\s\S]*?)\n\}/.exec(chatsSchema)?.[1] ?? '';
    expect(conversation).toMatch(/\bbrand_id\s+String/);
    expect(conversation).toMatch(/\bplayer_id\s+String\?/);
  });
});

describe('T031 — an empty reference stays empty', () => {
  it('the player reference is nullable and no backfill touches it', () => {
    const chatsSchema = readFileSync(
      join(__dirname, '..', '..', 'chats', 'prisma', 'schema.prisma'),
      'utf8',
    );
    // Nullable by design ("unlinked until linked"). A migration that attached those to *something*
    // would invent a customer for a conversation that has none.
    expect(chatsSchema).toMatch(/player_id\s+String\?/);
    expect(code()).not.toMatch(/UPDATE\s+"Conversation"/i);
  });
});

describe('T033 — the migration is re-runnable', () => {
  it('every creating statement is guarded', () => {
    const body = code();
    for (const stmt of body.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)[^;]*/gi) ?? []) {
      expect(stmt).toMatch(/IF NOT EXISTS/i);
    }
  });

  it('the edge-dependent block is skipped once the edge is gone', () => {
    // The first version of this migration was NOT idempotent: its own abort guard read `PlayerBrand`,
    // which the first run drops, so a second run died on `relation "PlayerBrand" does not exist`.
    // Found by running it twice against a clone — not by reading it.
    expect(code()).toMatch(/to_regclass\('"PlayerBrand"'\)\s+IS\s+NULL/i);
  });

  it('the key is replaced only while it is still the old one', () => {
    expect(code()).toMatch(/current_key\s+IS\s+DISTINCT\s+FROM\s+'account_id,brand_id,player_id'/i);
  });

  it('each foreign key is dropped before it is added', () => {
    const body = code();
    for (const name of ['ContactMatch_player_fkey', 'PersonMember_person_fkey', 'PersonMember_player_fkey']) {
      expect(body).toMatch(new RegExp(`DROP CONSTRAINT IF EXISTS "${name}"`, 'i'));
      expect(body).toMatch(new RegExp(`ADD CONSTRAINT\\s+"${name}"`, 'i'));
    }
  });
});

describe('the new key leads with the account', () => {
  it('so the injected isolation predicate stays index-aligned, and licensees cannot collide', () => {
    expect(code()).toMatch(/PRIMARY KEY \("account_id", "brand_id", "player_id"\)/i);
    expect(code()).toMatch(/PRIMARY KEY \("account_id", "person_id", "brand_id", "player_id"\)/i);
  });
});
