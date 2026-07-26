import { ANY, normaliseScope, resolveTarget, type SlaPolicy } from './policy-resolution';

/**
 * T031 (feature 014, US2) — target resolution. FAILS before the module exists, PASSES after.
 *
 * The assertion that matters most is the negative one: **no policy ⇒ no clock**. Absence of a target
 * is not a zero target. If this defaulted to anything, shipping the feature would silently start
 * breaching every conversation in every account that had not configured an SLA yet.
 */
const p = (target: number, brand = ANY, priority = ANY): SlaPolicy => ({
  target_minutes: target,
  scope_brand_id: brand,
  scope_priority: priority,
});

describe('resolveTarget — precedence', () => {
  const all = [p(60), p(30, 'b1'), p(20, ANY, 'high'), p(5, 'b1', 'high')];

  it('prefers (brand, priority) over everything', () => {
    expect(resolveTarget(all, { brandId: 'b1', priority: 'high' })).toBe(5);
  });

  it('falls back to (brand, *) when the priority is not scoped for that brand', () => {
    expect(resolveTarget(all, { brandId: 'b1', priority: 'low' })).toBe(30);
  });

  it('falls back to (*, priority) when the brand is not scoped', () => {
    expect(resolveTarget(all, { brandId: 'b9', priority: 'high' })).toBe(20);
  });

  it('falls back to the account default (*, *)', () => {
    expect(resolveTarget(all, { brandId: 'b9', priority: 'low' })).toBe(60);
  });

  it('prefers a brand override over a priority override (documented tie-break)', () => {
    // (b1,*) = 30 beats (*,high) = 20 for a high-priority conversation in b1.
    expect(resolveTarget([p(60), p(30, 'b1'), p(20, ANY, 'high')], { brandId: 'b1', priority: 'high' })).toBe(30);
  });

  it('ignores the priority dimension entirely when the conversation has no priority', () => {
    expect(resolveTarget([p(20, ANY, 'high'), p(60)], { brandId: 'b1', priority: null })).toBe(60);
  });
});

describe('resolveTarget — no policy means NO CLOCK', () => {
  it('returns null with no policies at all', () => {
    expect(resolveTarget([], { brandId: 'b1', priority: 'high' })).toBeNull();
  });

  it('returns null when nothing matches (a brand-only policy for another brand)', () => {
    expect(resolveTarget([p(30, 'b2')], { brandId: 'b1', priority: null })).toBeNull();
  });

  // A non-positive target is a broken row, not "reply instantly".
  it('ignores a non-positive target rather than treating it as an immediate breach', () => {
    expect(resolveTarget([p(0)], { brandId: 'b1', priority: null })).toBeNull();
    expect(resolveTarget([p(-5)], { brandId: 'b1', priority: null })).toBeNull();
  });

  it('falls through a broken specific policy to a valid general one', () => {
    expect(resolveTarget([p(0, 'b1'), p(45)], { brandId: 'b1', priority: null })).toBe(45);
  });
});

describe('normaliseScope', () => {
  it('maps empty/whitespace to the sentinel (never NULL — research R7)', () => {
    expect(normaliseScope(undefined)).toBe(ANY);
    expect(normaliseScope('')).toBe(ANY);
    expect(normaliseScope('   ')).toBe(ANY);
  });

  it('passes a real scope value through, trimmed', () => {
    expect(normaliseScope(' high ')).toBe('high');
    expect(normaliseScope('brand-1')).toBe('brand-1');
  });
});
