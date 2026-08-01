import { isSubstantive, MIN_SUBSTANTIVE_CHARS } from './substantive';

/**
 * T024 (feature 023, roadmap 4.18 — U8). Table-driven, because the rule is three conditions and the
 * interesting cases are the ones that satisfy two of them.
 */
describe('isSubstantive — the three conditions, and why each is needed', () => {
  it('accepts a real question', () => {
    expect(isSubstantive('не пришёл депозит, что делать')).toBe(true);
    expect(isSubstantive('no me llegó el depósito de ayer')).toBe(true);
    expect(isSubstantive('my withdrawal has been pending for two days')).toBe(true);
  });

  it('rejects a greeting in ANY seeded language (no language detection — research R6)', () => {
    for (const greeting of ['привет', 'hola', 'hi', 'buenas tardes', 'good morning', 'bom dia']) {
      expect(isSubstantive(greeting)).toBe(false);
    }
  });

  it('rejects punctuation-only and emoji-only', () => {
    for (const noise of ['?', '???', '!!!', '🙂', '🙂🙂🙂', '   ']) {
      expect(isSubstantive(noise)).toBe(false);
    }
  });

  // ── The boundaries. Each of these satisfies TWO conditions and must still be rejected. ──

  it('rejects 15+ characters of ONE repeated word (passes length, fails word count)', () => {
    const text = 'ааааааааааааааааааа';
    expect(text.length).toBeGreaterThanOrEqual(MIN_SUBSTANTIVE_CHARS);
    expect(isSubstantive(text)).toBe(false);
  });

  it('rejects the same word twice (two tokens, one word — still says nothing)', () => {
    expect(isSubstantive('депозит депозит депозит')).toBe(false);
  });

  it('rejects a long-enough, two-word GREETING (passes length and word count)', () => {
    // "buenas tardes" is 13 chars; "good evening" is 12 — both below the floor. This is the case that
    // proves the filler list is load-bearing rather than decorative:
    expect(isSubstantive('здравствуйте')).toBe(false);
    expect(isSubstantive('добрый вечер')).toBe(false);
  });

  it('rejects a short but genuine-looking phrase (fails length only)', () => {
    expect(isSubstantive('где деньги')).toBe(false);
  });

  it('accepts a greeting FOLLOWED by a real question — matching is whole-message, not substring', () => {
    // The most dangerous possible bug in the filler list: swallowing real questions that open politely.
    expect(isSubstantive('hola, no me llegó el depósito')).toBe(true);
    expect(isSubstantive('привет, не пришёл депозит вчера')).toBe(true);
  });

  it('is not fooled by casing, extra whitespace or trailing punctuation', () => {
    expect(isSubstantive('  ПРИВЕТ!!!  ')).toBe(false);
    expect(isSubstantive('Hola.')).toBe(false);
  });

  it('handles null and undefined as not substantive', () => {
    expect(isSubstantive(null)).toBe(false);
    expect(isSubstantive(undefined)).toBe(false);
    expect(isSubstantive('')).toBe(false);
  });
});
