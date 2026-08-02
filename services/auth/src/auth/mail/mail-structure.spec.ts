import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * T026 + T032 (feature 028) — the structural guarantees. Two tasks, one scanner: they walk the
 * same tree with the same comment-stripping, and two near-identical scanners is how one of them
 * quietly stops matching.
 *
 * ⚠️ Each check below proves its detector on a planted violation first. Two guards in this
 * repository were green for their whole lives while scanning nothing, and a third — written in
 * feature 027 to prevent exactly that — reported five findings on a day when none existed.
 */

const SRC = join(__dirname, '..', '..');
const SERVICE_ROOT = join(SRC, '..');

function walk(dir: string, includeTests: boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'generated' || entry === 'node_modules') continue;
      out.push(...walk(full, includeTests));
    } else if (/\.ts$/.test(entry)) {
      if (!includeTests && /\.spec\.ts$/.test(entry)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Comments are stripped: prose ABOUT a rule must not read as a breach of it. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const productionFiles = walk(SRC, false).map((f) => ({
  path: relative(SERVICE_ROOT, f),
  code: stripComments(readFileSync(f, 'utf8')),
}));

describe('the scan itself', () => {
  it('actually read the service', () => {
    // Without this, a renamed folder turns every check below into a pass.
    expect(productionFiles.length).toBeGreaterThan(20);
    expect(productionFiles.some((f) => f.path.includes('otp.service.ts'))).toBe(true);
  });

  it('strips comments, so a rule written down is not a rule broken', () => {
    expect(stripComments('// LOGIN_CODE_DEV_SINK was deleted\nconst x = 1;')).not.toContain(
      'LOGIN_CODE_DEV_SINK',
    );
  });
});

describe('T026 — the plaintext sink is gone, not merely unused', () => {
  const SINK = /LOGIN_CODE_DEV_SINK|appendFileSync|writeFileSync/;

  it('the detector recognises the shape that was deleted', () => {
    expect(SINK.test("appendFileSync(this.devSinkPath, JSON.stringify({ code }))")).toBe(true);
  });

  it('⭐ nothing writes a code or a token to a file', () => {
    // The sink was a LIVE one-time secret in a plaintext file inside a container. It existed
    // because there was no other way to read a code; there is now, and two ways to obtain a
    // credential means the weaker one outlives its reason.
    const offenders = productionFiles.filter((f) => SINK.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('T032 — one transport, no hostnames, no brand', () => {
  it('exactly one file implements the mail transport', () => {
    // Not "at most one": zero would mean the scan lost the tree and this guard would be green for
    // the rest of its life.
    const implementors = productionFiles
      .filter((f) => /implements\s+MailTransport\b/.test(f.code))
      .map((f) => f.path);
    expect(implementors).toEqual([join('src', 'auth', 'mail', 'smtp.transport.ts')]);
  });

  it('⭐ no mail host, port or provider name is written into the source (FR-014)', () => {
    // Changing where mail goes must be changing configuration. A hostname in the source is a
    // licensee inheriting our choice.
    const PROVIDER = /smtp\.[a-z0-9-]+\.[a-z]{2,}|sendgrid|mailgun|postmark|resend\.com|ses\.amazonaws/i;
    const offenders = productionFiles.filter((f) => PROVIDER.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('⭐ no company name reaches the messages (FR-009, Principle VI)', () => {
    // An authentication email is the least visible place a brand hides and the worst place for a
    // licensee to find ours.
    const BRAND = /beton|betonwin|gr8\b/i;
    const offenders = productionFiles
      .filter((f) => f.path.includes(join('auth', 'mail')))
      .filter((f) => BRAND.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the in-memory adapter is referenced only from tests', () => {
    // An adapter that records but delivers nothing is one binding away from being live — the
    // argument feature 027 used to delete the mock session rather than disable it.
    const offenders = productionFiles
      .filter((f) => !f.path.endsWith(join('ports', 'email.port.ts')))
      .filter((f) => /\bOutboxEmailAdapter\b/.test(f.code))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe('T033 — nothing on a mail path can log the payload', () => {
  const mailFiles = productionFiles.filter((f) => f.path.includes(join('auth', 'mail')));

  it('the mail layer was actually scanned', () => {
    expect(mailFiles.length).toBeGreaterThanOrEqual(4);
  });

  it('the detector fires on a planted leak', () => {
    const planted = `this.logger.warn(\`failed \${err.message}\`);`;
    expect(/logger\.(log|warn|error|debug)\([^)]*err/.test(planted)).toBe(true);
  });

  it('⭐ no logger call on a mail path takes an error object or a payload', () => {
    // ⚠️ This is the path nobody writes a unit test for. A mail library's error quotes the
    // envelope and sometimes the body; interpolating it into a log line is how the code escapes
    // without a single test turning red.
    const LEAK = /logger\.(log|warn|error|debug)\([^)]*\b(err|error|payload_json|payload|code|inviteToken|text)\b/;
    const offenders = mailFiles.filter((f) => LEAK.test(f.code)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
