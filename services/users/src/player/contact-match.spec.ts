import { createHash } from 'node:crypto';
import {
  normaliseContact,
  hashContact,
  contactHash,
  isLinkableIdentifier,
  MAX_RECORDS_PER_IDENTIFIER,
} from './contact-match';

/**
 * T019/T020/T022 (feature 020, US2) — the evidence layer.
 *
 * The operator's decision is that a matching email or phone links two records automatically. These
 * tests hold the two properties that make an automatic decision safe to make: it matches the same
 * human written two ways, and it declines a value that clearly is not a human at all.
 */

const SALT = 'synthetic-salt-for-tests-0123456789abcdef';

describe('T019 — normalisation matches the same human, never two different ones', () => {
  it('email: case and surrounding space do not make a second person', () => {
    expect(normaliseContact('email', 'A.User@Mail.com')).toBe('a.user@mail.com');
    expect(normaliseContact('email', '  a.user@mail.com ')).toBe('a.user@mail.com');
    expect(normaliseContact('email', 'A.User@Mail.com')).toBe(
      normaliseContact('email', 'a.user@mail.com '),
    );
  });

  it('email: dots and +tags are NOT stripped — that would be guessing, not normalising', () => {
    // Some providers treat `a.user@` and `auser@` as one mailbox; others do not. Merging them would
    // decide something about a person on a provider's behalf.
    expect(normaliseContact('email', 'a.user@mail.com')).not.toBe(
      normaliseContact('email', 'auser@mail.com'),
    );
    expect(normaliseContact('email', 'user+crm@mail.com')).not.toBe(
      normaliseContact('email', 'user@mail.com'),
    );
  });

  it('phone: formatting varies between brands, digits do not', () => {
    const forms = ['+34 600 111 222', '+34-600-111-222', '(+34) 600111222', '34600111222'];
    const normalised = forms.map((f) => normaliseContact('phone', f));
    expect(new Set(normalised).size).toBe(1);
    expect(normalised[0]).toBe('+34600111222');
  });

  it('phone: two different numbers stay different', () => {
    expect(normaliseContact('phone', '+34600111222')).not.toBe(
      normaliseContact('phone', '+34600111223'),
    );
  });

  it('rejects what is not usable as evidence about a person', () => {
    for (const bad of ['', '   ', 'not-an-email', '@mail.com', 'a@b']) {
      expect(normaliseContact('email', bad)).toBeNull();
    }
    // A fragment would match many people — the opposite of evidence.
    for (const bad of ['', '12345', '+34 600', 'phone']) {
      expect(normaliseContact('phone', bad)).toBeNull();
    }
    expect(normaliseContact('email', undefined)).toBeNull();
    expect(normaliseContact('phone', 42)).toBeNull();
  });
});

describe('T020 — *** the stored value is a salted hash, never the contact ***', () => {
  const EMAIL = 'a.user@mail.com';

  it('the plaintext appears nowhere in the stored value', () => {
    const h = hashContact('email', EMAIL, SALT);
    expect(h).not.toContain(EMAIL);
    expect(h).not.toContain('a.user');
    expect(h).not.toContain('mail.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the salt is actually applied — an unsalted hash does not match', () => {
    const salted = hashContact('email', EMAIL, SALT);
    const otherSalt = hashContact('email', EMAIL, 'a-different-salt-0123456789abcdefghij');
    expect(salted).not.toBe(otherSalt);
    // An unsalted sha256 of the address is a dictionary lookup away from the address itself.
    expect(salted).not.toBe(createHash('sha256').update(EMAIL).digest('hex'));
  });

  it('hashing refuses a short or absent salt rather than proceeding', () => {
    // Config already refuses to boot without one. If this ever throws, something bypassed the loader —
    // and hashing unsalted would be worse than failing.
    for (const bad of ['', 'salt', 'changeme', 'x'.repeat(31)]) {
      expect(() => hashContact('email', EMAIL, bad)).toThrow(/salt/i);
    }
  });

  it('the same value under a different KIND cannot collide into a match', () => {
    expect(hashContact('email', '+34600111222', SALT)).not.toBe(
      hashContact('phone', '+34600111222', SALT),
    );
  });

  it('equal inputs hash equal — matching works at all', () => {
    expect(contactHash('email', 'A.User@Mail.com', SALT)).toBe(
      contactHash('email', ' a.user@mail.com', SALT),
    );
  });

  it('an unusable value yields no hash, so it can never link anything', () => {
    expect(contactHash('email', 'not-an-email', SALT)).toBeNull();
    expect(contactHash('phone', '123', SALT)).toBeNull();
  });
});

describe('T022 — an identifier on more than two records is a placeholder, not a person', () => {
  it('two records may link; three or more may not', () => {
    expect(isLinkableIdentifier(2)).toBe(true);
    expect(isLinkableIdentifier(3)).toBe(false);
    expect(isLinkableIdentifier(50)).toBe(false);
  });

  it('one record links nothing — there is no second party', () => {
    expect(isLinkableIdentifier(1)).toBe(false);
    expect(isLinkableIdentifier(0)).toBe(false);
  });

  it('the ceiling is stated once, not repeated at call sites', () => {
    expect(MAX_RECORDS_PER_IDENTIFIER).toBe(2);
    expect(isLinkableIdentifier(MAX_RECORDS_PER_IDENTIFIER)).toBe(true);
    expect(isLinkableIdentifier(MAX_RECORDS_PER_IDENTIFIER + 1)).toBe(false);
  });
});
