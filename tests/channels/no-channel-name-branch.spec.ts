import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { CHANNEL_KINDS } from '../../libs/common/src';

/**
 * ⭐ T081 (feature 033, subpoint 2.1e — FR-003) — **NOTHING BRANCHES ON A CHANNEL NAME OR KEY.**
 *
 * ── The claim, and why it needs a scan ───────────────────────────────────────────────────────────
 * The two-level model is the same one feature 032 built for statuses: a **KIND** (`api | email |
 * messenger`) is the closed vocabulary in code that logic may branch on, and a **CHANNEL** is a
 * per-account row with a key, an address and a brand. It only pays for itself if the machine reads kinds.
 * The moment one function says `if (channel.key === 'stand-api-brand1')`, adding a channel stops being an
 * INSERT and becomes a deployment — and the admin screen at roadmap 3.10 / W15 cannot ship as data entry.
 *
 * ⚠️ **This guard was added by the `/speckit.analyze` pass, not by the original task list**, which had the
 * requirement (FR-003) and nothing enforcing it. Worth recording: feature 032 pays for the identical rule
 * with `tests/statuses/no-status-key-branch.spec.ts`, and the reason it does is that the rule is invisible
 * to a reader — code that branches on a name looks like ordinary code.
 *
 * Every other closed catalogue here has the same guard: permissions (011), automation triggers (014),
 * audit actions (015), upload purposes (016), export scopes (017), status keys (032).
 *
 * Comments are stripped first. A guard that bans a token from prose gets "fixed" by deleting the
 * explanation of why the token is banned — the choice `no-cross-service-access.spec.ts` made first.
 */
const ROOT = resolve(__dirname, '..', '..');

/** Every service, not just chats: the worker holds the mailbox and the gateway routes the webhook. */
const SERVICES = ['chats', 'users', 'worker', 'gateway'] as const;

/**
 * Files exempt from the scan, each with a reason.
 *
 * ⚠️ This list is the guard's own weak point, so it stays tiny and every entry is a file whose PURPOSE is
 * to name a channel rather than to react to one. A file added here because it was inconvenient would make
 * the scan decorative — which is why the test below asserts the list is short.
 */
const EXEMPT: string[] = [
  // Configuration parsing: the secret map is keyed BY channel key, so it necessarily handles them.
  'chats/config.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so the scan polices behaviour rather than vocabulary. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** Product code only: a spec legitimately names a channel to build a scenario. */
const SOURCES = SERVICES.flatMap((svc) => {
  const base = join(ROOT, 'services', svc, 'src');
  return walk(base)
    .filter((f) => !f.endsWith('.spec.ts'))
    .map((abs) => ({
      path: `${svc}/${abs.slice(base.length + 1).split(sep).join('/')}`,
      code: codeOf(abs),
    }));
}).filter((s) => !EXEMPT.includes(s.path));

describe('the scan sees the services (nothing below can pass by scanning nothing)', () => {
  it('reads a plausible number of source files across all four services', () => {
    expect(SOURCES.length).toBeGreaterThan(100);
    for (const svc of SERVICES) {
      expect(SOURCES.some((s) => s.path.startsWith(`${svc}/`))).toBe(true);
    }
  });

  it('the predicate fires on a real branch and stays quiet on ordinary code', () => {
    const fires = (code: string) => /['"`]stand-api-brand1['"`]/.test(code);
    expect(fires("if (channel.key === 'stand-api-brand1') return true;")).toBe(true);
    expect(fires("if (kind === 'email') return true;")).toBe(false);
  });

  it('the exemption list is SHORT — a long one would make this guard decorative', () => {
    expect(EXEMPT.length).toBeLessThanOrEqual(2);
  });
});

describe('*** no retired channel word survives in product code ***', () => {
  /**
   * `'chat'` was the pre-033 value for the widget, folded into `api` by the migration.
   *
   * ⚠️ Scanned as a WHOLE WORD in quotes. A bare substring search would match `chats` — the service's own
   * name, present in nearly every file — and a scan that cries wolf gets widened until it asserts nothing.
   */
  it('the word `chat` is not a channel value anywhere', () => {
    const offenders = SOURCES.filter((s) => /['"`]chat['"`]/.test(s.code)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });
});

describe('*** logic branches on a channel KIND, never on a channel identity ***', () => {
  /**
   * The kinds themselves are legitimate literals — they ARE the closed vocabulary, and
   * `channelKindFromStored('email')` is the intended shape. What must not appear is a channel's own
   * identity: its `key`, or its address.
   *
   * The scan therefore looks for the shape of an identity comparison rather than for a word list, because
   * the words are per-deployment configuration and cannot be enumerated here. `.key ===` and `.address ===`
   * are the two forms such a branch takes.
   */
  it('no comparison against a channel `key`', () => {
    const offenders = SOURCES.filter((s) => /\.key\s*===\s*['"`]/.test(s.code)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('no comparison against a channel `address`', () => {
    const offenders = SOURCES.filter((s) => /\.address\s*===\s*['"`]/.test(s.code)).map(
      (s) => s.path,
    );
    expect(offenders).toEqual([]);
  });

  it('the vocabulary the scan permits is exactly the three kinds', () => {
    // Pins the guard to the catalogue: adding a fourth kind is a deliberate edit in libs/common, and this
    // assertion is what makes somebody notice that this scan's premise changed with it.
    expect([...CHANNEL_KINDS]).toEqual(['api', 'email', 'messenger']);
  });
});
