import { withAccountScope, SEED_ACCOUNT_ID } from '@crm/common';
import { PrismaClient } from '../src/generated/prisma';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { buildSeed } from './seed.build';

/**
 * auth_db seed runner (feature 008). Writes the synthetic dataset via the account-scoped client
 * (feature 007) so every tenant row carries the seed account. Idempotent — upsert on stable keys.
 * Run: `DATABASE_URL=<auth_db url> npm run seed:auth` (live on beton-test — Track B).
 */
async function run(): Promise<void> {
  const base = new PrismaClient();
  const db = withAccountScope(base, SEED_ACCOUNT_ID, { scopedModels: SCOPED_MODELS });
  const seed = buildSeed();
  try {
    for (const role of seed.roles) await db.role.upsert({ where: { id: role.id }, create: role, update: role });
    // Feature 011 — permission catalogue + role default matrix (roles must exist first for the FK).
    for (const perm of seed.permissions)
      await db.permission.upsert({ where: { id: perm.id }, create: perm, update: perm });
    for (const rp of seed.rolePermissions)
      await db.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: rp.role_id, permission_id: rp.permission_id } },
        create: rp,
        update: {},
      });
    for (const user of seed.users) await db.user.upsert({ where: { id: user.id }, create: user, update: user });
    for (const cred of seed.credentials)
      await db.credential.upsert({ where: { id: cred.id }, create: cred, update: cred });
    for (const ur of seed.userRoles)
      await db.userRole.upsert({
        where: { user_id_role_id: { user_id: ur.user_id, role_id: ur.role_id } },
        create: ur,
        update: {},
      });
    // Feature 024 (roadmap 5.3): groups after users, so the membership FKs resolve. Idempotent by
    // stable id / composite key, like everything above.
    for (const g of seed.groups) await db.group.upsert({ where: { id: g.id }, create: g, update: g });
    for (const m of seed.groupMembers)
      await db.groupMember.upsert({
        where: { group_id_user_id: { group_id: m.group_id, user_id: m.user_id } },
        create: m,
        update: {},
      });
    // Empty by design — the shipped configuration restricts nothing (ADR 0039 §7). The loop stays so
    // that granting something later is a data change here rather than a code change.
    for (const gp of seed.groupPermissions)
      await db.groupPermission.upsert({
        where: {
          group_id_permission_id: { group_id: gp.group_id, permission_id: gp.permission_id },
        },
        create: gp,
        update: {},
      });
    console.log('auth seed: ok');
  } finally {
    await base.$disconnect();
  }
}

run().catch((err) => {
  console.error('auth seed failed:', err);
  process.exit(1);
});
