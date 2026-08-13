import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * ⭐ W31 / feature 038 (FR-006, SC-004, ADR 0043 §1) — **the key-bearing files log NOTHING AT ALL.**
 *
 * ── Why the rule is «no logger», and not «no logger that prints the key» ─────────────────────────
 * Three values pass through these folders and each is a credential in its own right: the API key's
 * plaintext value (it exists for exactly one response and never again), the request signature, and
 * the shared secret the signature is computed from. A leak of any of them is not a privacy incident —
 * it hands an outsider the ability to mint and disable staff accounts in our own account system.
 *
 * A per-value scan («no line contains `secret`») is the version of this test that passes while the
 * defect ships. The value travels inside objects that get spread, inside errors that get caught, and
 * inside request bodies that get echoed on a failure path nobody exercised — `logger.warn(\`refused:
 * ${JSON.stringify(req)}\`)` mentions none of the three words and prints all three values. So the
 * property is made **structural**: on this surface there is no logger to misuse. The spec asks for
 * exactly that — *«this is enforced structurally, not by review»* (spec.md, FR-006).
 *
 * ── What is given up, stated rather than discovered later ────────────────────────────────────────
 * These files cannot narrate a refusal. That is the trade: a refusal is observable through the AUDIT
 * trail (which records a key **fingerprint**, never a value) and through the rate limiter's counters.
 * Diagnosing a signature mismatch from a log line would mean printing the two things being compared,
 * which is the leak itself.
 *
 * Sibling guards, deliberately not merged: `tests/uploads/no-pii-in-logs.spec.ts` polices what a
 * logger may be given on the upload path — there, logging is legitimate and only its arguments are
 * constrained. Here, the argument list is irrelevant because there is no call.
 */
const ROOT = resolve(__dirname, '..', '..');

/** The three folders a key value, a signature or a shared secret can be in scope in. */
const KEY_BEARING_DIRS = [
  'services/auth/src/api-keys',
  'services/auth/src/provisioning',
  'services/gateway/src/provisioning',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    // `.spec.ts` is excluded: a test may print whatever it likes about a FIXTURE, and including them
    // would make this file flag its own siblings for asserting on a fake key.
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

/** Comments stripped — the scan polices behaviour, not prose (the house idiom for these guards). */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/**
 * Every way this repository actually writes a log line. Each shape is here because it exists
 * somewhere in the product, not because it is conceivable:
 *   • `console.*` — needs no import, so it is the one that arrives while debugging and stays;
 *   • `logInfo`   — libs/common's own structured line logger (it ends in `console.log`);
 *   • `this.logger.*` / `new Logger(...)` / `Logger.*` — the Nest idiom every service uses.
 * Importing `Logger` at all is flagged too: an import is the step before the call, and on this
 * surface there is no legitimate second use for it.
 */
const LOGGER_SHAPES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'console.*', re: /\bconsole\s*\.\s*(log|warn|error|info|debug|trace|dir|table)\s*\(/g },
  { label: 'logInfo()', re: /\blogInfo\s*\(/g },
  { label: 'this.logger.*', re: /\bthis\.logger\s*\.\s*\w+\s*\(/g },
  { label: 'new Logger()', re: /\bnew\s+Logger\s*\(/g },
  { label: 'Logger.*()', re: /(?<!\w)Logger\s*\.\s*\w+\s*\(/g },
  { label: 'Logger import', re: /import[^;]*\bLogger\b[^;]*from\s*['"]@nestjs\/common['"]/g },
];

function loggerCallsIn(code: string): string[] {
  return LOGGER_SHAPES.flatMap(({ label, re }) =>
    [...code.matchAll(new RegExp(re.source, 'g'))].map((m) => `${label}: ${m[0].trim()}`),
  );
}

const SOURCES = KEY_BEARING_DIRS.flatMap((d) => walk(join(ROOT, ...d.split('/')))).map((f) => ({
  file: rel(f),
  code: codeOf(readFileSync(f, 'utf8')),
}));

describe('the scan sees the key-bearing surface (guards against a vacuous pass)', () => {
  it('reads real files from all three folders', () => {
    expect(SOURCES.length).toBeGreaterThan(8);
    for (const dir of KEY_BEARING_DIRS) {
      expect(SOURCES.some((f) => f.file.startsWith(dir))).toBe(true);
    }
  });

  it('the files it read are the ones that HANDLE the secret material', () => {
    // The failure mode this catches is the folder being renamed or split while the guard keeps
    // passing over an empty set — «zero offenders» would then be true and meaningless.
    const all = SOURCES.map((f) => f.code).join('\n');
    expect(all).toMatch(/\bsecret\b/i);
    expect(all).toMatch(/\bsignature\b/i);
    expect(SOURCES.map((f) => f.file)).toContain('services/auth/src/provisioning/provisioning.verify.ts');
  });

  it('the predicate FIRES on a file that logs (so a green run means silence, not blindness)', () => {
    const logging = codeOf(`
      import { Injectable, Logger } from '@nestjs/common';
      import { logInfo } from '@crm/common';
      class X {
        private readonly logger = new Logger('X');
        run(req: { secret: string }) {
          console.warn('refused', req);
          this.logger.error(\`bad signature \${req.secret}\`);
          Logger.log('static');
          logInfo('auth', 'refused', { req });
        }
      }
    `);
    // All six shapes, so a regex that silently stopped matching cannot hide behind the other five.
    expect(loggerCallsIn(logging)).toHaveLength(6);
    // …and a file that only mentions logging in a comment is NOT flagged.
    expect(loggerCallsIn(codeOf('// console.log(secret) — deliberately absent\nconst a = 1;'))).toEqual([]);
  });
});

describe('*** nothing on the key-bearing surface writes a log line at all ***', () => {
  it.each(SOURCES.map((f) => [f.file]))('%s contains no logger call', (file) => {
    const found = loggerCallsIn(SOURCES.find((f) => f.file === file)!.code);
    // The whole offending call is reported rather than a bare count: the point of failing here is to
    // show the author the line to delete, and the answer is always «delete it», never «redact it».
    expect({ file, logs: found }).toEqual({ file, logs: [] });
  });
});
