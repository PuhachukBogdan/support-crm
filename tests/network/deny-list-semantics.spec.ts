import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isAddressAllowed, isAddressDenied, normalise } from '@crm/common';
import { isHostAllowed, isRecipientAllowed } from '@crm/common';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ W32 (roadmap 12.10, FR-027) — **THREE LISTS, THREE DIFFERENT MEANINGS OF EMPTY.**
 *
 * This product now has three address/host lists, and their empty-list behaviour is deliberately NOT
 * the same:
 *
 *   • `isAddressAllowed`  (inbound, per API key)  — empty ⇒ **nobody may act**
 *   • `isAddressDenied`   (inbound, the boundary) — empty ⇒ **nobody is refused**
 *   • `isHostAllowed` / `isRecipientAllowed` (outbound mail) — empty ⇒ **no restriction**
 *
 * Each is correct for the question it answers, and every pair of them looks like an inconsistency
 * somebody should tidy. So they are asserted TOGETHER, in one file, with the reasoning attached —
 * because the tidy-up is a one-line change that looks obviously right and is catastrophic in two of
 * the three directions:
 *
 *   ⛔ deny-list made fail-closed  ⇒ every user locked out of a system nobody attacked.
 *   ⛔ allow-list made fail-open   ⇒ a key that mints staff accounts, open to the internet.
 *
 * This file exists so that change cannot be made quietly. If you are here because it went red: the
 * question is not «which default is right», it is «which list did I just change, and what does an
 * empty one MEAN there».
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('*** ⭐ the three empty-list meanings, side by side ***', () => {
  it('an empty ALLOW-list permits nobody — a key nobody configured is a key nobody trusted', () => {
    expect(isAddressAllowed('203.0.113.9', [])).toBe(false);
  });

  it('an empty DENY-list refuses nobody — the ordinary state of a deployment', () => {
    expect(isAddressDenied('203.0.113.9', [])).toBe(false);
  });

  it('an empty OUTBOUND list does not restrict — mail an operator never narrowed still leaves', () => {
    expect(isHostAllowed('smtp.example.test', [])).toBe(true);
    expect(isRecipientAllowed('someone@example.test', [])).toBe(true);
  });

  it('and each list still works when it is NOT empty (anti-vacuous)', () => {
    expect(isAddressAllowed('203.0.113.9', ['203.0.113.9'])).toBe(true);
    expect(isAddressAllowed('198.51.100.1', ['203.0.113.9'])).toBe(false);
    expect(isAddressDenied('203.0.113.9', ['203.0.113.9'])).toBe(true);
    expect(isAddressDenied('198.51.100.1', ['203.0.113.9'])).toBe(false);
  });
});

describe('one machine written two ways is one address', () => {
  it.each([
    ['mixed case', '203.0.113.9', '203.0.113.9'],
    ['surrounding space', '  203.0.113.9 ', '203.0.113.9'],
    ['IPv4-mapped IPv6', '::ffff:203.0.113.9', '203.0.113.9'],
    ['IPv4-mapped, upper case', '::FFFF:203.0.113.9', '203.0.113.9'],
  ])('%s', (_name, written, expected) => {
    expect(normalise(written)).toBe(expected);
    // ⚠️ The point is not the helper — it is that a BAN saved in one form matches a caller arriving
    // in another. A stored address that never matches is a ban present on the screen and stopping
    // nobody, which is worse than no ban because somebody believes in it.
    expect(isAddressDenied(written, [expected])).toBe(true);
    expect(isAddressDenied(expected, [written])).toBe(true);
  });
});

describe('the two inbound lists share ONE definition of the caller', () => {
  it('the deny helper lives beside the allow helper, and both cite the other', () => {
    // Not a style check: if the deny-list ever grew its own normalisation, the same request could be
    // allowed by one list and matched by neither — and the disagreement would surface as «the ban
    // does not work» weeks later, on one machine, unreproducibly.
    const src = readFileSync(
      join(resolve(__dirname, '..', '..'), 'libs/common/src/net/ip-allow-list.ts'),
      'utf8',
    );
    expect(src).toContain('isAddressAllowed');
    expect(src).toContain('isAddressDenied');
    expect(src).toContain('mail/guards.ts');

    const mail = readFileSync(
      join(resolve(__dirname, '..', '..'), 'libs/common/src/mail/guards.ts'),
      'utf8',
    );
    // The mail guard must keep pointing back, so a reader meeting the second file never has to guess
    // whether the first was a mistake.
    expect(mail).toContain('ip-allow-list');
  });
});
