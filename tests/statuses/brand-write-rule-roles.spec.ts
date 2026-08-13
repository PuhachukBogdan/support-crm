import { hasPermission } from '../../libs/common/src';
import { ROLE_DEFAULTS, SYSTEM_CATALOGUE } from '../../services/auth/src/rbac/catalogue';
import { AUDIT_ACTIONS, DETAIL_KEYS, parseDetail, AuditDetailError } from '../../libs/common/src/audit';

/**
 * ⭐ T021 (feature 032, roadmap 4.16 — R22) — WHO may change a conversation's brand, and what the trail
 * records when they do.
 *
 * ── Why here and not in the chats spec ───────────────────────────────────────────────────────────
 * The rule spans two services: `chats` enforces a permission KEY, `auth` decides which roles hold it.
 * A chats spec importing auth's catalogue would cross the boundary Principle VIII draws — in a test, but
 * in the direction the product may never go. The root suite is the tier that legitimately sees both, and
 * `services/chats/src/conversation/brand-write-rule.spec.ts` asserts the enforcement half.
 *
 * ⚠️ Asserted against the role TEMPLATES, not against a sentence in an ADR: the feature-011 R-2 corollary
 * says a key nobody lists is OFF, and this is where "nobody lists it" becomes checkable.
 */
const KEY = 'crm.conversation.set_brand';

/** Roles that hold work on conversations and must NOT be able to re-brand one. */
const AGENT_ROLES = ['support_agent', 'vip_support', 'am', 'shift_am'] as const;
/** The supervisory roles the operator's rule names, plus the two that get everything. */
const SUPERVISOR_ROLES = ['teamlead', 'admin', 'super_admin'] as const;

describe('the permission key exists exactly once, in the right category', () => {
  it('is a single `crm` entry with a human label', () => {
    const entries = SYSTEM_CATALOGUE.filter((e) => e.key === KEY);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.category).toBe('crm');
    expect(entries[0]!.label.length).toBeGreaterThan(5);
  });

  it('⚠️ is NOT a reuse of the everyday reply key — one key per scope', () => {
    expect(KEY).not.toBe('crm.conversation.reply');
    expect(SYSTEM_CATALOGUE.some((e) => e.key === 'crm.conversation.reply')).toBe(true);
  });
});

describe('*** no agent role may change a brand; the supervisory roles may ***', () => {
  it.each(AGENT_ROLES)('%s does NOT hold the key', (role) => {
    expect(hasPermission([...ROLE_DEFAULTS[role]!], KEY)).toBe(false);
  });

  it.each(AGENT_ROLES)('⭐ POSITIVE CONTROL: %s still holds the everyday conversation write key', (role) => {
    // Without this, the four refusals above would be satisfied by a role template that grants nothing —
    // and a product where nobody can do anything also "does not leak".
    expect(hasPermission([...ROLE_DEFAULTS[role]!], 'crm.conversation.reply')).toBe(true);
  });

  it.each(SUPERVISOR_ROLES)('%s holds the key', (role) => {
    expect(hasPermission([...ROLE_DEFAULTS[role]!], KEY)).toBe(true);
  });
});

describe('the audit action the change files (ADR 0019)', () => {
  it('is live, written by chats, and in the `assignment` class', () => {
    const spec = AUDIT_ACTIONS['conversation.brand_changed'];
    expect(spec).toBeDefined();
    expect(spec.status).toBe('live');
    expect(spec.writer).toBe('chats');
    expect(spec.class).toBe('assignment');
  });

  it('accepts the two brand refs and nothing else', () => {
    expect(DETAIL_KEYS.assignment).toContain('fromBrandRef');
    expect(DETAIL_KEYS.assignment).toContain('toBrandRef');
    expect(
      parseDetail('conversation.brand_changed', { fromBrandRef: 'brand-a', toBrandRef: 'brand-b' }),
    ).toEqual({ fromBrandRef: 'brand-a', toBrandRef: 'brand-b' });
  });

  it('⚠️ refuses a brand NAME-shaped leak the same way every other detail is refused', () => {
    // The allow-list is by KEY, so the realistic mistake is not a new field — it is PII arriving under a
    // permitted one. `detail.ts` refuses that on the VALUE, and this pins it for the new action.
    expect(() =>
      parseDetail('conversation.brand_changed', { toBrandRef: 'ops@example.com' }),
    ).toThrow(AuditDetailError);
    expect(() => parseDetail('conversation.brand_changed', { brandName: 'Casino X' })).toThrow(
      AuditDetailError,
    );
  });
});
