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
    const out = maskPlayer(PLAYER, 'support_agent') as Record<string, unknown>;
    expect(out.player_id).toBe('p1');
    for (const masked of ['am_notes', 'preferences', 'portfolio', 'vip', 'segment', 'gr8_snapshot']) {
      expect(masked in out).toBe(false); // absent, not present-with-null
    }
  });

  it('for AM: am-only fields are present', () => {
    const out = maskPlayer(PLAYER, 'am') as Record<string, unknown>;
    expect(out.am_notes).toBe('called re: bonus');
    expect(out.preferences).toEqual({ channel: 'sms' });
    expect(out.segment).toBe('Premium');
    // AM still does not receive the raw GR8 PII snapshot.
    expect('gr8_snapshot' in out).toBe(false);
  });

  it('for VIP Support: operational present, am-only absent', () => {
    const out = maskPlayer(PLAYER, 'vip_support') as Record<string, unknown>;
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
