import { CONTACT_PATTERN_KINDS, contactShapedKinds, patternKindsDetail } from './contact-shaped';
import { AuditDetailError, parseDetail } from '../audit/detail';

/**
 * W35 / 040 (R35, U17) — the note detector. FAILS before the module exists, PASSES after.
 *
 * The table below is the feature's actual promise, and the negative half of it is deliberately written
 * down: a detector whose misses are undocumented gets trusted for things it never did. U17 accepted
 * those misses when it chose warn-over-block, so they belong in the test rather than in nobody's head.
 */
describe('contactShapedKinds — what a phone number written by a person looks like', () => {
  it.each([
    ['+34 600 123 456', ['phone']],
    ['клиент просил перезвонить на +34600123456 вечером', ['phone']],
    ['номер 0501234567, звонить после 18', ['phone']],
    ['tel 050 123 45 67', ['phone']],
  ])('%s → %s', (body, expected) => {
    expect(contactShapedKinds(body)).toEqual(expected);
  });

  it.each([
    ['ivan@example.com', ['email']],
    ['писал с ivan.petrov+vip@mail.example.co.uk, там же и отвечает', ['email']],
  ])('%s → %s', (body, expected) => {
    expect(contactShapedKinds(body)).toEqual(expected);
  });

  it.each([
    ['в телеграме он @ivan_petrov', ['handle']],
    ['t.me/ivanpetrov', ['handle']],
    ['https://wa.me/34600123456', ['handle', 'phone']],
  ])('%s → %s', (body, expected) => {
    expect(contactShapedKinds(body)).toEqual(expected);
  });

  it('reports all three kinds when all three are there, sorted and deduplicated', () => {
    const body = 'ivan@example.com, @ivan_petrov, +34 600 123 456 — и ещё раз ivan@example.com';
    expect(contactShapedKinds(body)).toEqual(['email', 'handle', 'phone']);
  });

  /**
   * ⚠️ An email must NOT also be reported as a handle. It matches the handle shape at its local part, and
   * an entry claiming two disclosures where there was one would overstate the trail — the feature-026
   * lesson about a trail that overstates being worse than one that does not.
   */
  it('an email alone is one kind, not two', () => {
    expect(contactShapedKinds('пишите на ivan@example.com')).toEqual(['email']);
  });

  it.each([
    ['клиент недоволен сроками вывода, обещали до пятницы'],
    ['проверил бонус — начислен корректно'],
    ['VIP с 2019 года, играет по выходным'],
    ['сумма 350 евро'],
    [''],
  ])('an ordinary note reports nothing: %s', (body) => {
    expect(contactShapedKinds(body)).toEqual([]);
  });

  /**
   * ── The documented MISSES ────────────────────────────────────────────────────────────────────────
   * U17's own reasoning: a hard block is defeated by writing the number in words, which is precisely why
   * this warns instead. So the miss is expected, and pinning it here is what keeps the next reader from
   * assuming a guarantee this function never made.
   */
  it('does NOT catch a number spelled out in words (U17 predicted exactly this)', () => {
    expect(contactShapedKinds('телефон: восемь девять два три четыре пять')).toEqual([]);
  });

  it('does NOT catch a handle written without the @', () => {
    expect(contactShapedKinds('в телеграме он ivan_petrov')).toEqual([]);
  });

  /**
   * ⚠️ The accepted FALSE POSITIVE, also pinned. Our own numeric identifiers trip the digit run, and that
   * is the right trade for a detector that only warns: the author waves it through in one click, and the
   * alternative — tightening until ids pass — is what would let real numbers through. This is the exact
   * opposite decision from `looksLikePersonalData`, whose firing REFUSES a write.
   */
  it('DOES fire on a bare numeric id, and that is accepted rather than tuned away', () => {
    expect(contactShapedKinds('игрок 100000123 просил уточнить')).toEqual(['phone']);
  });
});

describe('patternKindsDetail — expressible in an audit entry BY CONSTRUCTION', () => {
  it('joins the closed vocabulary with commas', () => {
    expect(patternKindsDetail(['email', 'phone'])).toBe('email,phone');
    expect(patternKindsDetail([])).toBe('');
  });

  it('every possible kind list passes the audit value guard', () => {
    // The whole point of recording KINDS rather than values: there is no member of this vocabulary, and
    // no combination of them, that the personal-data guard could refuse. Asserted over the real
    // `parseDetail`, not over a copy of its rules.
    for (const a of CONTACT_PATTERN_KINDS) {
      for (const b of CONTACT_PATTERN_KINDS) {
        const value = patternKindsDetail([a, b]);
        expect(parseDetail('player.note_flagged', { patternKinds: value })).toEqual({
          patternKinds: value,
        });
      }
    }
  });

  it('…while the matched value itself remains inexpressible under the same key', () => {
    // The negative control. If this ever stopped throwing, the key would have become a hole exactly
    // where the feature promises there is none.
    expect(() =>
      parseDetail('player.note_flagged', { patternKinds: '+34 600 123 456' }),
    ).toThrow(AuditDetailError);
    expect(() => parseDetail('player.note_flagged', { patternKinds: 'ivan@example.com' })).toThrow(
      AuditDetailError,
    );
  });

  it('the note body cannot arrive under any key of this action', () => {
    expect(() =>
      parseDetail('player.note_flagged', { body: 'клиент просил перезвонить' } as never),
    ).toThrow(AuditDetailError);
  });
});
