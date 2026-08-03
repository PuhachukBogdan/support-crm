import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_WORDMARK } from './branding';

/**
 * T037 (feature 029 — roadmap 9.1's missing criteria, FR-023; Principle VI, decision 0028).
 *
 * **No brand name, logo path or literal colour anywhere in the shell chrome.**
 *
 * This is the requirement that would bite on a licence sale, and it bites quietly: a hardcoded name
 * looks correct in every screenshot until the wrong customer sees the wrong word. Branding is
 * per-brand configuration over CSS-variable tokens — never a literal in a component.
 *
 * ⚠️ **The guard proves itself.** A scan that matches nothing passes for two reasons — because the
 * code is clean, or because the scan is broken — and this repository has shipped the second kind. So:
 * the file list is asserted non-empty, and every pattern is fired at a planted violation.
 */
const SHELL_DIR = __dirname;

function shellSources(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SHELL_DIR)) {
    const full = join(SHELL_DIR, entry);
    if (statSync(full).isDirectory()) continue;
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** A hex colour anywhere in the chrome — colour belongs to tokens (0028). */
const HEX = /#[0-9a-fA-F]{3,8}\b/;

/**
 * Company-identifying words. Deliberately includes the names actually in play around this project,
 * because the realistic failure is somebody typing the customer's own name into a header, not an
 * abstract "BrandName".
 */
const BRAND_WORDS = /\b(beton|betonwin|gr8|zendesk|chatwoot|slotico)\b/i;

/** An image asset that would carry a logo. Tokens and inline SVG marks are fine; files are not. */
const LOGO_ASSET = /['"][^'"]*\/?(logo|brandmark|wordmark)[^'"]*\.(svg|png|jpe?g|webp)['"]/i;

describe('the brand scan can actually find something (guards against a vacuous pass)', () => {
  const files = shellSources();

  it('there are shell sources to scan', () => {
    expect(files.length).toBeGreaterThan(4);
  });

  it('the scan reads real content', () => {
    const total = files.reduce((n, f) => n + readFileSync(f, 'utf8').length, 0);
    expect(total).toBeGreaterThan(2000);
  });

  it('⭐ every pattern fires on a planted violation', () => {
    expect(HEX.test('const c = "#ff0044";')).toBe(true);
    expect(BRAND_WORDS.test('<span>Beton Support</span>')).toBe(true);
    expect(BRAND_WORDS.test("title: 'GR8 CRM'")).toBe(true);
    expect(LOGO_ASSET.test('<img src="/assets/logo.svg" />')).toBe(true);
    // …and does not fire on the clean forms, or the guard would be unusable.
    expect(HEX.test('className="bg-primary"')).toBe(false);
    expect(BRAND_WORDS.test('Support CRM')).toBe(false);
    expect(LOGO_ASSET.test('<div className="rounded bg-primary" />')).toBe(false);
  });
});

describe('*** the shell hardcodes no brand (FR-023) ***', () => {
  const files = shellSources();

  it('no hex colour literal', () => {
    const offenders = files.filter((f) => HEX.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no company-identifying word', () => {
    const offenders = files.filter((f) => BRAND_WORDS.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no logo or wordmark image asset', () => {
    const offenders = files.filter((f) => LOGO_ASSET.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('⭐ the wordmark is CONFIGURATION with a neutral default, not a literal in a component', () => {
    // The default names what the software IS, the way "Mail" does — it does not name a company.
    expect(PRODUCT_WORDMARK).toBe('Support CRM');
    expect(BRAND_WORDS.test(PRODUCT_WORDMARK)).toBe(false);

    const sidebar = readFileSync(join(SHELL_DIR, 'sidebar.tsx'), 'utf8');
    // The component renders the configured value; it does not contain the string itself.
    expect(sidebar).toContain('PRODUCT_WORDMARK');
    expect(sidebar).not.toContain('Support CRM');
  });
});
