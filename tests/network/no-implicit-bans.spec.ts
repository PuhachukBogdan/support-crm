import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * ⭐ W32 (roadmap 12.10, FR-030) — **AN ADDRESS IS BANNED BECAUSE A PERSON TYPED IT. Never otherwise.**
 *
 * ── The failure this forbids ────────────────────────────────────────────────────────────────────
 * Every product with a deny-list eventually grows an automatic writer: "ban after N failed logins",
 * "ban on abuse", "ban on rate limit". Each is one small commit and each turns the control into a
 * weapon somebody else holds — an attacker who can make requests LOOK like they come from an address
 * can have that address banned. Spoof the forwarded header from a customer's office, or simply fail
 * to sign in five times from a shared network, and the product locks out people nobody attacked.
 *
 * The roadmap point states it as a requirement in its own right («nothing in the product can add an
 * entry implicitly»), so it is asserted structurally: the only writers are the two the admin surface
 * owns. A guard rather than a rule, because the tempting commit is small, plausible and arrives from
 * a different direction each time.
 */
const ROOT = resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'generated' || entry === 'gen' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

/** Comments stripped: a mention in prose is not a write, and this guard must not fire on its own text. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const SERVICE_FILES = walk(join(ROOT, 'services'));
/** `create`, `createMany`, `upsert`, `delete`, `deleteMany` on the deny-list table. */
const WRITES = /deniedAddress\s*\.\s*(create|createMany|upsert|delete|deleteMany|updateMany|update)\s*\(/;

describe('*** ⭐ nothing writes to the deny-list except the administrator’s own surface ***', () => {
  it('exactly one file in the product writes denied addresses', () => {
    const writers = SERVICE_FILES.filter((f) => WRITES.test(codeOf(f))).map(rel);
    // The repository the admin rpcs go through, and nothing else. Not the lockout service, not a
    // rate limiter, not an importer, not the offboarding sweep.
    expect(writers).toEqual(['services/auth/src/network/denied-address.repository.ts']);
  });

  it('the lockout path — the likeliest future offender — writes nothing here', () => {
    // Named specifically because it is the one place in the product that already reacts to repeated
    // failure, and «while we are locking the account, ban the address too» is the exact commit this
    // guard exists to stop.
    const lockout = codeOf(join(ROOT, 'services/auth/src/auth/lockout.service.ts'));
    expect(lockout).not.toContain('deniedAddress');
  });

  it('the scan can SEE a write (anti-vacuous)', () => {
    // A guard that scans nothing passes for ever. This proves the predicate fires on the real writer
    // and that the corpus is not empty.
    expect(SERVICE_FILES.length).toBeGreaterThan(100);
    expect(WRITES.test('await tx.deniedAddress.create({ data })')).toBe(true);
    expect(WRITES.test('const rows = await db.deniedAddress.findMany({})')).toBe(false);
  });
});
