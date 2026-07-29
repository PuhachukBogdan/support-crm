import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T034 [Polish] — FR-012: **no surface resolves a player from a bare platform id.**
 *
 * The composite key made every stale call site fail to compile, which is why it was chosen. But a
 * compiler only guards the paths that go through the typed repository. This guard covers the rest:
 * a hand-written `where: { player_id }`, a `findUnique` on the platform id, a helper that quietly
 * takes one argument again. Those compile fine and resolve the wrong customer.
 *
 * The detector proves itself against known-bad samples before any clean result is trusted — this
 * repository has found six guards that could not fail, and the discipline is what stops a seventh.
 */

const PLAYER_DIR = __dirname;
const SERVICE_SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated') continue; // Prisma's own runtime, not ours
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(entry) && !/\.spec\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments stripped: prose about the old key must not read as the old key. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** A player lookup keyed on the platform id alone. */
const BARE_LOOKUP = /where:\s*\{\s*player_id\s*[,:}]/;

/** A unique selector that is not the composite one. */
const BARE_UNIQUE = /player\.(findUnique|update|delete|upsert)\s*\(\s*\{\s*where:\s*\{\s*player_id/;

describe('the detector is not vacuous', () => {
  it('fires on a bare lookup', () => {
    expect(BARE_LOOKUP.test('where: { player_id: id },')).toBe(true);
    expect(BARE_LOOKUP.test('where: { player_id },')).toBe(true);
    expect(BARE_UNIQUE.test('db.player.findUnique({ where: { player_id: id } })')).toBe(true);
  });

  it('does not fire on the composite selector', () => {
    const good = 'where: { account_id_brand_id_player_id: { account_id, brand_id, player_id } }';
    expect(BARE_LOOKUP.test(good)).toBe(false);
    expect(BARE_UNIQUE.test(`db.player.findUnique({ ${good} })`)).toBe(false);
  });

  it('and there are files to scan', () => {
    // Without this, a renamed folder turns the guard off silently.
    expect(walk(SERVICE_SRC).length).toBeGreaterThan(10);
  });
});

describe('*** no player is resolved from a platform id alone ***', () => {
  it('no bare `where: { player_id }` anywhere in the service', () => {
    const offenders = walk(SERVICE_SRC).filter((f) => BARE_LOOKUP.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it('no unique player operation keyed on the platform id', () => {
    const offenders = walk(SERVICE_SRC).filter((f) => BARE_UNIQUE.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it('the triple is only ever built THROUGH the constructor', () => {
    // If a second place assembled the literal itself, "what identifies a player" would be a
    // convention again — and a convention is exactly what the previous key was. Passing the object
    // to `playerIdentity(...)` is fine and expected; writing it loose is not.
    //
    // This caught `person.service.ts` returning raw literals from `membersOf`, which then flowed
    // straight into a feed query unvalidated.
    const loose = walk(PLAYER_DIR).filter((f) => {
      const body = codeOf(f).replace(/playerIdentity\(\{[\s\S]*?\}\)/g, '');
      return /accountId:\s*[^,]+,\s*brandId:\s*[^,]+,\s*playerId:/.test(body);
    });
    // EMPTY, not "only the constructor file". `player.identity.ts` builds its result from validated
    // parts rather than from a literal, so it does not match either — and expecting it to was my own
    // wrong assumption, corrected when the guard disagreed.
    expect(loose.map((f) => f.split(/[\\/]/).pop())).toEqual([]);
  });

  it('the repository exposes no method taking a bare player id', () => {
    const repo = codeOf(join(PLAYER_DIR, 'player.repository.ts'));
    expect(repo).not.toMatch(/getPlayerById/);
    expect(repo).toMatch(/getPlayer\(id: PlayerIdentity\)/);
  });
});
