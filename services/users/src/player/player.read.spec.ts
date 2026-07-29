import { Metadata } from '@grpc/grpc-js';
import { PlayerReadController } from './player.grpc.controller';
import type { PlayerWithBrands } from './player.repository';

/**
 * T020 / T021 / T025 (feature 018, US1) — **masking is real, per role, and happens in the right ORDER.**
 *
 * Two assertions here are worth more than the rest, and neither is about the happy path:
 *
 * 1. **A withheld field is ABSENT, not empty** — checked by inspecting keys. A blanked field still tells
 *    the reader that the field exists and has a value, which is the disclosure the allow-list design exists
 *    to prevent (SEC-AP1 / FR-006).
 * 2. **The wire message is built from an EXPLICIT list, never a spread** — because `maskPlayer` *keeps* the
 *    GR8 snapshot for the broadest roles (they are cleared for its tier). What keeps that customer PII out
 *    of every response is that the contract has no field for it. So the snapshot assertions live at the
 *    **wire** layer; asserting them on the masked row would be testing the wrong thing, and would pass
 *    while a spread leaked.
 */
const ROW: PlayerWithBrands = {
  player_id: 'ply-1',
  account_id: 'acc-1',
  vip: true,
  segment: 'high-roller',
  am_notes: 'prefers calls after 18:00',
  preferences: { channel: 'telegram' },
  portfolio: { tier: 'gold' },
  custom_attributes: { source: 'affiliate-7' },
  gr8_snapshot: { surname: 'Smith', phone: '+34 600 123 456' },
  gr8_fetched_at: new Date('2026-07-28T09:00:00.000Z'),
  gr8_stale: false,
  created_at: new Date('2026-07-28T08:00:00.000Z'),
  updated_at: new Date('2026-07-28T08:30:00.000Z'),
  brands: [
    { player_id: 'ply-1', brand_id: 'brand-a' },
    { player_id: 'ply-1', brand_id: 'brand-b' },
  ],
};

function md(role: string, over: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'user-1');
  m.set('x-actor-permissions', 'crm.contact.view,crm.inbox.view');
  m.set('x-actor-effective-role', role);
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  return m;
}

interface AuditCall {
  accountId: string;
  actorUserId: string;
  target: string;
  roleKey: string;
  underPreview: boolean;
}

function harness(row: PlayerWithBrands | null = ROW) {
  const views: AuditCall[] = [];
  const bulk: AuditCall[] = [];
  const access = {
    recordView: jest.fn(
      async (accountId: string, actorUserId: string, target: string, roleKey: string, underPreview = false) => {
        views.push({ accountId, actorUserId, target, roleKey, underPreview });
      },
    ),
    recordBulkRead: jest.fn(
      async (accountId: string, actorUserId: string, target: string, roleKey: string, _f: string[], underPreview = false) => {
        bulk.push({ accountId, actorUserId, target, roleKey, underPreview });
      },
    ),
  };
  const players = {
    getPlayerById: jest.fn(async () => row),
    listByBrand: jest.fn(async () => ({ rows: row ? [row] : [], nextCursor: null })),
  };
  const operators = { getById: jest.fn(async () => null) };
  return {
    ctl: new PlayerReadController(players as never, operators as never, access as never),
    players,
    access,
    views,
    bulk,
  };
}

describe('*** four roles, four different field sets *** (FR-006 / SC-002)', () => {
  it('each tier is a superset of the one below, by KEYS not values', async () => {
    const present = async (role: string) => {
      const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md(role))) as Record<string, unknown>;
      // "Present" means a non-default value: a masked-away field lands as proto3's default, so the honest
      // question at the wire layer is which fields carry data.
      return new Set(
        Object.entries(wire)
          .filter(([, v]) => v !== '' && v !== false && !(Array.isArray(v) && v.length === 0))
          .map(([k]) => k),
      );
    };

    const agent = await present('support_agent');
    const lead = await present('teamlead');
    const am = await present('am');
    const admin = await present('admin');

    // Strictly growing. If any pair were equal, the tier would be buying nothing.
    expect(agent.size).toBeLessThan(lead.size);
    expect(lead.size).toBeLessThan(am.size);
    for (const k of agent) expect(lead.has(k)).toBe(true);
    for (const k of lead) expect(am.has(k)).toBe(true);
    for (const k of am) expect(admin.has(k)).toBe(true);
  });

  it('a linear role sees no operational and no portfolio field', async () => {
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('support_agent'))) as Record<string, unknown>;
    // ⚠️ These assertions used to read `.toBe('')` / `.toBe(false)` — they pinned the DEFECT.
    // 011's FR-014 requires a withheld field to be ABSENT from the serialized response; the message
    // was manufacturing proto3 defaults instead, so every key reached the client blanked. Fixed
    // 2026-07-29 (feature 019); the wire now omits what the mask dropped. `toBeUndefined` rather than
    // a falsiness check on purpose: blank and absent are exactly what this test must tell apart.
    for (const k of ['vip', 'segment', 'amNotes', 'preferencesJson', 'portfolioJson', 'customAttributesJson']) {
      expect(wire[k]).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(wire, k)).toBe(false);
    }
    // …and none of the actual values leaked into any field.
    expect(JSON.stringify(wire)).not.toContain('high-roller');
    expect(JSON.stringify(wire)).not.toContain('after 18:00');
  });

  it('an operational role sees operational fields and NOT the portfolio', async () => {
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('teamlead'))) as Record<string, unknown>;
    expect(wire.vip).toBe(true);
    expect(wire.segment).toBe('high-roller');
    expect(wire.customAttributesJson).toContain('affiliate-7');
    // The portfolio side is a tier up — and absent, not blank (FR-014; see the note above).
    for (const k of ['amNotes', 'preferencesJson', 'portfolioJson']) {
      expect(Object.prototype.hasOwnProperty.call(wire, k)).toBe(false);
    }
  });

  it('an account manager sees the portfolio', async () => {
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('am'))) as Record<string, unknown>;
    expect(wire.amNotes).toBe('prefers calls after 18:00');
    expect(wire.preferencesJson).toContain('telegram');
    expect(wire.portfolioJson).toContain('gold');
  });

  it('an unknown role is treated as the most restricted, never as privileged', async () => {
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('role_invented_next_year'))) as Record<string, unknown>;
    for (const k of ['vip', 'segment', 'amNotes']) {
      expect(Object.prototype.hasOwnProperty.call(wire, k)).toBe(false);
    }
  });
});

describe('*** T021: the ROW is masked before the WIRE message is built ***', () => {
  it('populated am_only columns are absent from the wire for an operational role', async () => {
    // The ordering proof. Masking runs on the row's own field names, so building the message first and
    // masking it afterwards would need a second field→tier map keyed by wire names — two maps obliged to
    // agree, which is the defect shape feature 017 found already broken between two filter vocabularies.
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('vip_support'))) as Record<string, unknown>;
    for (const k of ['preferencesJson', 'portfolioJson', 'amNotes']) {
      expect(Object.prototype.hasOwnProperty.call(wire, k)).toBe(false);
    }
    // The row itself was fully populated — so absence here can only come from masking.
    expect(ROW.preferences).not.toBeNull();
  });
});

describe('*** the GR8 snapshot never reaches the WIRE — asserted at the right layer ***', () => {
  it.each(['support_agent', 'teamlead', 'am', 'admin', 'super_admin'])(
    'no gr8 field and no snapshot value for %s',
    async (role) => {
      /**
       * ⚠️ Asserted on the WIRE, deliberately. `maskPlayer` KEEPS `gr8_snapshot` for admin and super_admin —
       * they are cleared for its tier — so the masked ROW legitimately still contains it. What keeps it out
       * of every response is that the contract has no field for it, which makes the explicit wire mapping
       * the actual guarantee. A row-layer assertion would fail for the broad roles and would tell us
       * nothing about what a client receives.
       */
      const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md(role))) as Record<string, unknown>;
      expect(Object.keys(wire).some((k) => /gr8/i.test(k))).toBe(false);
      const serialized = JSON.stringify(wire);
      expect(serialized).not.toContain('Smith');
      expect(serialized).not.toContain('600 123 456');
    },
  );
});

describe('*** account_id survives — it is mapped OUTSIDE masking ***', () => {
  it.each(['support_agent', 'am', 'super_admin'])('present for %s', async (role) => {
    // It is unclassified, so masking drops it for EVERY role including the broadest. Reading it from the
    // masked row would have made this field empty for everybody — the response carrying no account at all.
    // It comes from the caller's own context instead, because that is what it is: context, not customer data.
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md(role))) as Record<string, unknown>;
    expect(wire.accountId).toBe('acc-1');
  });
});

describe('brand ids are derived from the classified relation', () => {
  it('every brand the player belongs to is listed', async () => {
    // The policy classifies `brands` (the relation); `brand_ids` is not a classified field at all, so the
    // wire list has to be derived from whatever survived masking.
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md('support_agent'))) as Record<string, unknown>;
    expect(wire.brandIds).toEqual(['brand-a', 'brand-b']);
  });
});

describe('*** T025: view-as masks as the PREVIEWED role and audits the REAL caller ***', () => {
  it('the response is shaped by the previewed role, not the real one', async () => {
    // The whole point of view-as. The resolver puts the previewed role in the effective role, so the owner
    // previewing an agent sees what the agent sees.
    const wire = (await harness().ctl.getPlayer(
      { playerId: 'ply-1' },
      md('support_agent', { 'x-is-preview': 'true' }),
    )) as Record<string, unknown>;
    for (const k of ['vip', 'amNotes']) {
      expect(Object.prototype.hasOwnProperty.call(wire, k)).toBe(false);
    }
  });

  it('the audit entry names the real caller plus the marker, never the previewed role', async () => {
    const h = harness();
    await h.ctl.getPlayer({ playerId: 'ply-1' }, md('am', { 'x-is-preview': 'true' }));
    expect(h.views).toHaveLength(1);
    expect(h.views[0]!.actorUserId).toBe('user-1');
    expect(h.views[0]!.underPreview).toBe(true);
    // The previewed role is passed for the TIER, and is not the actor. Nobody performed anything as a role.
    expect(h.views[0]!.roleKey).toBe('am');
  });
});
