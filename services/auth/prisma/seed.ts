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
    for (const user of seed.users) await db.user.upsert({ where: { id: user.id }, create: user, update: user });
    for (const cred of seed.credentials)
      await db.credential.upsert({ where: { id: cred.id }, create: cred, update: cred });
    for (const ur of seed.userRoles)
      await db.userRole.upsert({
        where: { user_id_role_id: { user_id: ur.user_id, role_id: ur.role_id } },
        create: ur,
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
