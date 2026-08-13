import { RpcException } from '@nestjs/microservices';
import { maskPlayer, assertCanMassExport } from './player.masking';

/**
 * Feature 011 US4 (T040/T042 — SC-006/SC-008). Masking builds the player DTO by allow-list: fields
 * a role may not see are ABSENT from the object (not null). Mass export is refused for linear roles.
 */
const PLAYER = {
  player_id: 'p1',
  account_id: 'acc1',
  vip: true,
  segment: 'Premium',
  am_notes: 'called re: bonus',
  preferences: { channel: 'sms' },
  portfolio: { tier: 'gold' },
  custom_attributes: { x: 1 },
  gr8_snapshot: { surname: 'Doe', phone: '+100', email: 'd@e.com' },
  gr8_stale: false,
  created_at: new Date('2026-01-01'),
  brands: [{ brand_id: 'b1' }],
};

describe('player masking (anti-pitching, allow-list)', () => {
  it('for a linear role: masked fields are ABSENT, not null (SC-006)', () => {
    const out = maskPlayer(PLAYER, 'support_agent', { attachedToSubject: false }) as Record<
      string,
      unknown
    >;
    expect(out.player_id).toBe('p1');
    for (const masked of [
      'am_notes',
      'preferences',
      'portfolio',
      'vip',
      'segment',
      'gr8_snapshot',
    ]) {
      expect(masked in out).toBe(false); // absent, not present-with-null
    }
  });

  it('for AM: am-only fields are present', () => {
    const out = maskPlayer(PLAYER, 'am', { attachedToSubject: true }) as Record<string, unknown>;
    expect(out.am_notes).toBe('called re: bonus');
    expect(out.preferences).toEqual({ channel: 'sms' });
    expect(out.segment).toBe('Premium');
    // AM still does not receive the raw GR8 PII snapshot.
    expect('gr8_snapshot' in out).toBe(false);
  });

  it('for VIP Support: operational present, am-only absent', () => {
    const out = maskPlayer(PLAYER, 'vip_support', { attachedToSubject: false }) as Record<
      string,
      unknown
    >;
    expect(out.segment).toBe('Premium');
    expect('am_notes' in out).toBe(false);
  });

  it('mass export refused for a linear role (SC-008)', () => {
    expect(() => assertCanMassExport('support_agent')).toThrow(RpcException);
  });

  it('mass export allowed for VIP Support and above', () => {
    expect(() => assertCanMassExport('vip_support')).not.toThrow();
    expect(() => assertCanMassExport('am')).not.toThrow();
  });
});

/**
 * Feature 022 (roadmap 4.13), T049 — **the person id is visible to everyone, and it widens NOTHING.**
 *
 * The field says which HUMAN a brand-scoped record belongs to. It is identity, not contact data: a linear
 * agent has always been able to see which brand a customer came from, and "these two records are one
 * person" is the same class of fact with no value attached. So it is tier `open`.
 *
 * The assertion that matters is the second one. Exposing a new fact about a customer is exactly the moment
 * a masking boundary quietly moves, so the below-the-boundary role is checked for both things at once: it
 * gets the person id **and** still gets no contact fields, no operational fields and no portfolio (SEC-AP1
 * unchanged).
 */
describe('person_id masking (feature 022)', () => {
  const LINKED = { ...PLAYER, person_id: 'person-1' } as Record<string, unknown>;

  it('a LINEAR role sees the person id — and still sees nothing it could pitch with', () => {
    const out = maskPlayer(LINKED, 'support_agent', { attachedToSubject: false }) as Record<
      string,
      unknown
    >;
    expect(out.person_id).toBe('person-1');
    // The boundary is unmoved: everything above `open` stays absent, not null.
    for (const withheld of [
      'am_notes',
      'preferences',
      'portfolio',
      'segment',
      'vip',
      'gr8_snapshot',
    ]) {
      expect(withheld in out).toBe(false);
    }
  });

  it('every role sees it, including the ones cleared for PII (it is not a tiered secret)', () => {
    for (const role of [
      'support_agent',
      'teamlead',
      'vip_support',
      'am',
      'shift_am',
      'admin',
      'super_admin',
    ]) {
      expect({
        role,
        personId: (
          maskPlayer(LINKED, role, { attachedToSubject: false }) as Record<string, unknown>
        ).person_id,
      }).toEqual({
        role,
        personId: 'person-1',
      });
    }
  });

  it('an unknown role — treated as linear — sees it too, and nothing else new', () => {
    const out = maskPlayer(LINKED, 'not-a-role', { attachedToSubject: false }) as Record<
      string,
      unknown
    >;
    expect(out.person_id).toBe('person-1');
    expect('am_notes' in out).toBe(false);
  });

  it('an UNLINKED record carries the key with a null value, never a fabricated person', () => {
    // The mask must pass `null` through rather than dropping the key: the wire mapper turns absence into an
    // empty string, and "linked to nobody" has to be expressible.
    const out = maskPlayer({ ...PLAYER, person_id: null }, 'support_agent', {
      attachedToSubject: false,
    }) as Record<string, unknown>;
    expect('person_id' in out).toBe(true);
    expect(out.person_id).toBeNull();
  });
});
