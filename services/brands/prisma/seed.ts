import { withAccountScope, SEED_ACCOUNT_ID } from '@crm/common';
import { PrismaClient } from '../src/generated/prisma';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { buildSeed } from './seed.build';

/**
 * brands_db seed runner (feature 008). Account-scoped writes (feature 007); idempotent upserts.
 * Run: `DATABASE_URL=<brands_db url> npm run seed:brands` (live on beton-test — Track B).
 */
async function run(): Promise<void> {
  const base = new PrismaClient();
  const db = withAccountScope(base, SEED_ACCOUNT_ID, { scopedModels: SCOPED_MODELS });
  const seed = buildSeed();
  try {
    for (const brand of seed.brands)
      await db.brand.upsert({ where: { id: brand.id }, create: brand, update: brand });
    for (const rule of seed.brandAccessRules)
      await db.brandAccessRule.upsert({ where: { id: rule.id }, create: rule, update: rule });
    console.log('brands seed: ok');
  } finally {
    await base.$disconnect();
  }
}

run().catch((err) => {
  console.error('brands seed failed:', err);
  process.exit(1);
});
