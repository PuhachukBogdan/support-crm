import { withAccountScope, SEED_ACCOUNT_ID } from '@crm/common';
import { PrismaClient } from '../src/generated/prisma';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { buildSeed } from './seed.build';

/**
 * users_db seed runner (feature 008). Account-scoped writes (feature 007); idempotent upserts.
 * Run: `DATABASE_URL=<users_db url> npm run seed:users` (live on beton-test — Track B).
 */
async function run(): Promise<void> {
  const base = new PrismaClient();
  const db = withAccountScope(base, SEED_ACCOUNT_ID, { scopedModels: SCOPED_MODELS });
  const seed = buildSeed();
  try {
    for (const op of seed.operators) await db.operator.upsert({ where: { id: op.id }, create: op, update: op });
    // Keyed by the TRIPLE since feature 020. The two seeded players share a platform id and differ
    // only by brand — under the old `where: { player_id }` the second upsert OVERWROTE the first,
    // which is the defect in one line.
    for (const p of seed.players)
      await db.player.upsert({
        where: {
          account_id_brand_id_player_id: {
            account_id: p.account_id,
            brand_id: p.brand_id,
            player_id: p.player_id,
          },
        },
        create: p,
        update: p,
      });
    console.log(`users seed: ok (${seed.players.length} players, incl. the cross-brand id collision)`);
  } finally {
    await base.$disconnect();
  }
}

run().catch((err) => {
  console.error('users seed failed:', err);
  process.exit(1);
});
