import { RbacResolverService } from './resolver.service';
import { ROLE_DEFAULTS } from './catalogue';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';
import type { PrismaService } from '../prisma.service';

/**
 * Feature 011 US5 (T048/T050). The resolver's view-as branch (R-5): with a `previewRole`, it returns
 * that role's DEFAULT permission set marked read-only — shaping reads as the previewed role WITHOUT
 * touching the caller's own permissions or granting write capability (FR-020/021 / SC-009).
 *
 * G1 (FR-019): "God" carries NO extra authority — it is a super-admin. view-as is the sole exclusive,
 * gated by `platform.view_as`, which is a super_admin default and is NOT in the admin default.
 */
describe('RbacResolverService — view-as preview', () => {
  function resolver() {
    const prisma = makeFakePrisma({
      permissions: [{ key: 'crm.inbox.view' }, { key: 'crm.contact.view' }, { key: 'platform.role.manage' }],
      rolePermissions: [
        { roleKey: 'support_agent', permKey: 'crm.inbox.view' },
        { roleKey: 'support_agent', permKey: 'crm.contact.view' },
        { roleKey: 'super_admin', permKey: 'platform.role.manage' },
      ],
    }) as unknown as PrismaService;
    return new RbacResolverService(prisma);
  }

  it('resolves the PREVIEWED role default set, read-only (does not use the caller identity)', async () => {
    const r = await resolver().resolve('acct-1', 'caller-is-a-super-admin', 'support_agent');
    expect(r.roleKey).toBe('support_agent');
    expect(r.permissionKeys.sort()).toEqual(['crm.contact.view', 'crm.inbox.view']);
    expect(r.isPreview).toBe(true);
    expect(r.readOnly).toBe(true);
    // NOT the previewer's own perms (support_agent lacks role management).
    expect(r.permissionKeys).not.toContain('platform.role.manage');
  });

  it('unknown previewed role → empty set, still read-only', async () => {
    const r = await resolver().resolve('acct-1', 'u', 'no_such_role');
    expect(r.permissionKeys).toEqual([]);
    expect(r.readOnly).toBe(true);
  });

  it('G1: view-as is a super_admin exclusive — admin default excludes platform.view_as', () => {
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.view_as');
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.view_as');
    // God == a super_admin: no separate elevated key set exists beyond the super_admin defaults.
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.role.manage');
  });
});
