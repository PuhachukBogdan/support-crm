import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sourceLines, stripComments } from '@crm/common';

/**
 * ⭐⭐ W36 / feature 041 — **EXACTLY ONE PLACE SETS A PASSWORD, AND EXACTLY ONE PLACE CAN.**
 *
 * ── Why this is a test and not a convention ──────────────────────────────────────────────────────
 * Two surfaces need to set a password (recovery and the signed-in change) and they share nothing else.
 * That is precisely the moment feature 011's mistake recurs: *the second surface that needed an audit
 * store found writing a fresh table easier than routing through the existing writer, and nothing
 * failed* — feature 015 then migrated 29 live rows out of it.
 *
 * A second password writer would be worse than a second audit store, because the two would drift on the
 * things that are invisible until they matter: whether the policy ran, whether `last_rotated_at` moved,
 * and whether **every session died**. All three are properties nobody notices are missing until an
 * account is not actually secured.
 *
 * ⛔ And one more absence this file pins: **no verb anywhere sets SOMEBODY ELSE's password.** Re-invitation
 * already covers the operational need; a "reset for user X" capability is the one that turns an
 * administrator compromise into every account.
 */
const ROOT = resolve(__dirname, '..', '..');
const WRITER = 'services/auth/src/auth/password.service.ts';

/**
 * ⚠️ Runtime code only. `prisma/` (seeds — fixture builders, and `prepare-test-server` documents their
 * own hazard) and `tests/` (doubles) are excluded deliberately: a seed writing a credential is not a
 * product path, and pretending otherwise would force the guard to be loosened until it proved nothing.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'gen' || entry === 'dist') continue;
    if (entry === 'prisma' || entry === 'tests') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (abs: string): string => abs.slice(ROOT.length + 1).split(sep).join('/');

const SOURCES = walk(join(ROOT, 'services')).map((abs) => ({
  path: rel(abs),
  code: stripComments(readFileSync(abs, 'utf8')),
}));

describe('the scan reads the real backend (nothing below can pass vacuously)', () => {
  it('sees the services and the writer itself', () => {
    expect(SOURCES.length).toBeGreaterThan(150);
    expect(SOURCES.map((s) => s.path)).toContain(WRITER);
  });
});

/**
 * ⚠️ **THE RULE IS ABOUT REPLACEMENT, NOT ABOUT THE COLUMN — and the first draft of this file had it
 * wrong.** It asserted «exactly one place assigns `secret_hash`» and named seven offenders, of which
 * five were legitimate:
 *
 * - `api-keys.*` write `ApiKey.secret_hash` — a different model entirely, and the column name is blind
 *   to that;
 * - `registration.service.ts` and `onboarding.service.ts` **CREATE** a person's first credential, which
 *   is a genuinely different act: there is no old password to know, no session to kill, and no rotation
 *   to stamp;
 * - the seeds are fixtures.
 *
 * So the property worth guarding is: **a password that already exists is REPLACED in exactly one place**,
 * and creation happens only where a credential comes into being. That distinction is the one that
 * matters, and stating it is what stops the guard being widened later until it asserts nothing.
 */
describe('*** replacing an existing password happens in exactly ONE place ***', () => {
  /** A Prisma write against the `Credential` model, by verb. */
  const writeOn = (verb: string) => new RegExp(`\\bcredential\\s*\\.\\s*${verb}\\s*\\(`);

  /**
   * ⚠️ **The distinction is not the VERB, and the second draft of this file learnt that too.**
   *
   * `registration.service.ts` and `onboarding.service.ts` both `create`-or-`update`: if a credential row
   * already exists carrying the seed's placeholder hash, they fill it. That is still «a password coming
   * into being» — nobody could sign in before it, so there is no session to kill and nothing to stamp as
   * rotated.
   *
   * What must stay unique is the replacement of a password somebody has been USING, because that is the
   * act with three invisible obligations (policy, rotation stamp, every session dead). So the permitted
   * set is named by FILE, not by verb, and a fourth file touching a credential is a decision that has to
   * edit this line.
   */
  const CREDENTIAL_ORIGIN = [
    // The invited person setting their first password (feature 010) — may land on a placeholder row.
    'services/auth/src/auth/registration.service.ts',
    // The whitelist bootstrap: the first super-admin, before anybody can invite anybody.
    'services/auth/src/auth/onboarding.service.ts',
  ];

  it('`credential.update` exists only in PasswordService and the two origin paths', () => {
    const writers = SOURCES.filter((s) => writeOn('update').test(s.code)).map((s) => s.path);
    expect(writers.sort()).toEqual([WRITER, ...CREDENTIAL_ORIGIN].sort());
  });

  it('…and only PasswordService both replaces AND kills the sessions', () => {
    // The property that makes the exception above safe: the origin paths do not revoke, because there
    // is nothing to revoke — and if one of them ever grows a `revokeUserChain` call, it has become a
    // password CHANGE wearing a registration's clothes and must route through the writer instead.
    for (const path of CREDENTIAL_ORIGIN) {
      const src = SOURCES.find((s) => s.path === path)!;
      expect({ path, revokes: /revokeUserChain\s*\(/.test(src.code) }).toEqual({ path, revokes: false });
    }
    expect(SOURCES.find((s) => s.path === WRITER)!.code).toMatch(/revokeUserChain\s*\(/);
  });

  it('no `upsert` or `updateMany` on a credential exists anywhere — including the writer', () => {
    // `upsert` would blur create and replace into one call and take the rotation stamp with it;
    // `updateMany` could touch two rows, which `@@unique([user_id, type])` exists to make impossible.
    for (const verb of ['upsert', 'updateMany', 'deleteMany']) {
      const offenders = SOURCES.filter((s) => writeOn(verb).test(s.code)).map((s) => s.path);
      expect({ verb, offenders }).toEqual({ verb, offenders: [] });
    }
  });

  it('CREATION is permitted only where a credential comes into being', () => {
    const creators = SOURCES.filter((s) => writeOn('create').test(s.code)).map((s) => s.path);
    expect(creators.sort()).toEqual([...CREDENTIAL_ORIGIN].sort());
  });

  it('the predicates FIRE (so the emptiness above means something)', () => {
    expect(writeOn('update').test('await tx.credential.update({ where: { id } })')).toBe(true);
    expect(writeOn('update').test('await this.prisma.apiKey.update({})')).toBe(false);
    // …and a comment naming the ban does not trip it.
    expect(writeOn('update').test(stripComments('// never call credential.update here'))).toBe(false);
  });
});

describe('*** the writer does all four things — asserted on its SOURCE, not only on its behaviour ***', () => {
  const writer = SOURCES.find((s) => s.path === WRITER)!;

  it.each([
    ['the policy', /validatePassword\s*\(/],
    ['the hash', /hashPassword\s*\(/],
    ['the rotation stamp', /last_rotated_at/],
    ['killing every session', /revokeUserChain\s*\(/],
    ['the trail', /audit\.append\s*\(/],
  ])('calls %s', (_name, pattern) => {
    // A behavioural spec proves these happen today. This proves they are all still IN the one place —
    // so "somebody moved the revocation out to a caller" is a build failure rather than a discovery.
    expect(pattern.test(writer.code)).toBe(true);
  });

  it('sets the credential by its unique id, never by a filter that could match two rows', () => {
    expect(writer.code).toMatch(/credential\.update\s*\(\s*\{[\s\S]*where:\s*\{\s*id:/);
  });
});

describe('⛔ *** no verb sets somebody ELSE’s password ***', () => {
  it('no rpc or route is named for an administrator reset', () => {
    const proto = readFileSync(
      join(ROOT, ...'libs/proto/crm/auth/v1/auth.proto'.split('/')),
      'utf8',
    );
    const rpcs = [...proto.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    const offenders = rpcs.filter((n) => /(Reset|Set)\w*Password/i.test(n) && !/ChangeOwn/.test(n));
    expect(offenders).toEqual([]);
  });

  it('the change request carries NO user field — the subject is the caller', () => {
    const proto = readFileSync(
      join(ROOT, ...'libs/proto/crm/auth/v1/auth.proto'.split('/')),
      'utf8',
    );
    const block = /message\s+ChangeOwnPasswordRequest\s*\{([\s\S]*?)\n\}/.exec(proto);
    expect(block).not.toBeNull();
    const fields = sourceLines(block![1]!)
      .map((l) => /^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=/.exec(l)?.[1])
      .filter((n): n is string => !!n);
    // ⚠️ The same construction `EnsureOwnOperator` and `SetMyAvatar` use: there is no field to name
    // anybody else, so the capability cannot be widened by a caller — only by editing this contract.
    expect(fields.sort()).toEqual(['current_password', 'new_password']);
  });
});
