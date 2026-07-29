import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contactHash } from './contact-match';

/**
 * T035 [Polish] (feature 020) — the contact projection leaks nothing, **by construction**.
 *
 * The claim is not that these paths happen to avoid printing a value. It is that **there is no value
 * to print**: `ContactMatch` stores a salted hash, so the tier policy has nothing extra to classify,
 * masking has nothing extra to cover, exports gain no field, and a careless log line has nothing to
 * reveal.
 *
 * Asserted here so that a future *"just store the normalised email too, it is easier to debug"* is a
 * failing test rather than a code-review opinion. That change would be the cheapest possible way to
 * undo the reason the hash was chosen.
 */

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
const MODEL = /model ContactMatch \{([\s\S]*?)\n\}/.exec(SCHEMA)?.[1] ?? '';
const SALT = 'synthetic-salt-for-tests-0123456789abcdef';

function sourceOf(file: string): string {
  return readFileSync(join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the scan reads the real artefacts', () => {
  it('found the model (nothing below can pass vacuously)', () => {
    expect(MODEL.length).toBeGreaterThan(50);
  });
});

describe('*** the projection stores a hash and no contact value ***', () => {
  it('the stored column is a hash', () => {
    expect(MODEL).toMatch(/value_hash\s+String/);
  });

  it('no column holds an address, a number, a name or an "original"', () => {
    for (const forbidden of ['email', 'phone', 'address', 'surname', 'value ', 'raw']) {
      expect(MODEL).not.toMatch(new RegExp(`\\b${forbidden.trim()}\\s+String`));
    }
  });

  it('the KIND is stored — a reader learns WHAT matched without learning what it was', () => {
    expect(MODEL).toMatch(/kind\s+String/);
  });

  it('a real hash reveals nothing about its input', () => {
    const h = contactHash('email', 'a.user@mail.com', SALT)!;
    for (const fragment of ['a.user', 'mail.com', '@']) expect(h).not.toContain(fragment);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('neither module writes a log line of its own', () => {
  it.each(['contact-match.ts', 'person.service.ts'])('%s has no logger and no console call', (f) => {
    // The strongest available form, and it costs nothing here: nothing in these files has anything to
    // say that the audit trail does not already record — and the trail carries the KIND, not a value.
    const src = sourceOf(f);
    expect(src).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\b/);
    expect(src).not.toMatch(/\bnew Logger\b/);
  });

  it('the matcher never interpolates a contact value into a thrown message', () => {
    const src = sourceOf('contact-match.ts');
    const throws = src.match(/throw new Error\([^)]*\)/g) ?? [];
    expect(throws.length).toBeGreaterThan(0); // it does throw — the check is not vacuous
    for (const t of throws) {
      expect(t).not.toMatch(/normalised|raw|value(?!_hash)/);
    }
  });
});
