import {
  withAccountScope,
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_BRAND_ID,
  SEED_PLAYER_ID,
  SEED_PRESENCE_ONLINE_USER_IDS,
  SEED_ROUTING_USER_IDS,
} from '@crm/common';
import { AssignmentRepository } from '../src/assignment/assignment.repository';
import { AssignmentService } from '../src/assignment/assignment.service';
import { PlayerRepository } from '../src/player/player.repository';
import { OperatorRepository } from '../src/operator/operator.repository';
import { PresenceRepository } from '../src/presence/presence.repository';
import { PresenceService } from '../src/presence/presence.service';
import { OperatorTransitionRecorder } from '../src/transition/transition.recorder';
import { PrismaClient } from '../src/generated/prisma';
import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { buildSeed } from './seed.build';

/**
 * users_db seed runner (feature 008). Account-scoped writes (feature 007); idempotent upserts.
 * Run: `DATABASE_URL=<users_db url> npm run seed:users` (live on beton-test — Track B).
 *
 * ⚠️ **This seed is run with `tsx --tsconfig tsconfig.base.json`, and it must be.**
 *
 * There is no `tsconfig.json` at the repository root, so `tsx` invoked from there compiles with
 * esbuild's defaults — which do NOT enable `experimentalDecorators`. Every other seed gets away with
 * it because none of them imports a Nest-decorated class. Feature 025 does, deliberately: presence is
 * established through `PresenceService`, the product's own write path, so that the seed cannot set a
 * state without the transition that must accompany it (FR-039).
 *
 * Found on the FIRST live run, as a `TransformError` naming `presence.repository.ts:39` — the
 * `@Inject()` on a constructor parameter. Recorded here because the failure is at build time in a
 * script nobody runs locally, and the next person to hit it will be looking at the presence code
 * rather than at a missing compiler flag.
 */
async function run(): Promise<void> {
  const base = new PrismaClient();
  const db = withAccountScope(base, SEED_ACCOUNT_ID, { scopedModels: SCOPED_MODELS });
  const seed = buildSeed();
  try {
    /**
     * ⚠️ Keyed on `(account_id, auth_user_id)`, NOT on the row id — changed 2026-08-05 after the seed threw
     * on a stand where people had signed in.
     *
     * ⭐ The same shape MVP block W1 fixed for `Credential` two paragraphs of history ago, and W1 is what
     * created it: that block added BOTH `@@unique([account_id, auth_user_id])` and the runtime writer
     * (`EnsureOwnOperator`, which does `operator.create` with a generated uuid on a person's first login).
     * From then on a seeded user who had logged in owned a profile under a DIFFERENT id, so an upsert keyed
     * on the synthetic id tried to INSERT and hit the constraint — `P2002`, and the seed stopped there,
     * leaving everything after this loop unwritten. W1's own live round missed it only by ordering: it
     * seeded before anybody signed in, which is the one sequence where the two ids never meet.
     *
     * ⚠️ `update` deliberately omits `id`. Matching on the pair means the existing row's id is the
     * RUNTIME's, and writing ours over it would repoint a primary key that `chats` references by value
     * (`Conversation.assignee_operator_id` is a soft ref, so nothing would stop it) — silently reassigning
     * or orphaning that person's conversations. The seed's job is to make the profile exist, not to own its
     * identifier.
     */
    for (const op of seed.operators)
      await db.operator.upsert({
        where: {
          account_id_auth_user_id: { account_id: op.account_id, auth_user_id: op.auth_user_id },
        },
        create: op,
        // Named field by field rather than spread-minus-id: a field added to the dataset later should
        // have to be considered here, not arrive silently on an existing person's profile.
        update: { display_name: op.display_name, active: op.active },
      });
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
    /**
     * Feature 022 (roadmap 4.13): the explicitly linked cross-brand person.
     *
     * Written AFTER the players, because `PersonMember` carries a real foreign key to `Player` on the triple
     * — the one place in this schema where a link is enforced by the database rather than by a service
     * remembering to check (feature 020). Seeding the members first would fail on that constraint, which is
     * the constraint doing its job.
     *
     * The person is upserted by id and the members by their composite key, so re-seeding is idempotent and
     * a re-run cannot silently create a second person for the same records.
     */
    for (const person of seed.persons)
      await db.person.upsert({ where: { id: person.id }, create: person, update: person });
    for (const m of seed.personMembers)
      await db.personMember.upsert({
        where: {
          account_id_person_id_brand_id_player_id: {
            account_id: m.account_id,
            person_id: m.person_id,
            brand_id: m.brand_id,
            player_id: m.player_id,
          },
        },
        create: m,
        update: m,
      });
    // ── Feature 025 (roadmap 5.9): labels, then the demo desk's presence ────────────────────────
    for (const label of seed.presenceLabels)
      await db.presenceLabel.upsert({ where: { id: label.id }, create: label, update: label });

    /**
     * ⭐ Presence is established through the PRODUCT'S OWN write path, never by inserting rows.
     *
     * Feature 024's three live-run defects were all one bug class: *the fixture was not what the
     * script believed it was.* A seed that wrote presence rows directly would be that bug
     * pre-installed — it would set a state without the transition that must accompany it, and the
     * first thing anyone checked against the history would disagree with the table.
     *
     * Going through `PresenceService` also means the seed inherits every rule the product has:
     * a no-op writes nothing, so re-seeding is idempotent for free; and each real change writes
     * exactly one transition, so a freshly seeded database has an honest history rather than a
     * silent one.
     *
     * ⚠️ This is a STATEMENT, not a default. Absent this block every seeded agent would be
     * `offline` — correct, and also a database in which feature 024's group routing resolves to an
     * empty pool. The demo desk is online because the seed says so, not because presence defaults
     * to available (FR-011/FR-039/FR-040).
     */
    // The repository reaches tenant data ONLY through `forAccount`, which is a `PrismaService`
    // method rather than a raw-client one — so the seed supplies the same account-scoped wrapper it
    // uses everywhere else, rather than handing over the unscoped client. Passing `base` directly is
    // what the first live run did, and it failed loudly at `forAccount is not a function`: the
    // isolation seam refusing to be bypassed even by a script, which is the seam working.
    const scoped = {
      forAccount: (accountId: string) =>
        withAccountScope(base, accountId, { scopedModels: SCOPED_MODELS }),
    };
    const presence = new PresenceService(
      new PresenceRepository(scoped as never),
      new OperatorTransitionRecorder(),
    );
    /**
     * ⚠️ TWO operations, and the second is not optional — found on the first live run.
     *
     * `setState` sets the STATE; it deliberately does not stamp activity, because an activity
     * timestamp is not a transition (58 agents × once a minute would otherwise be the whole history).
     * A seed that only set the state left agents `online` with a `last_seen_at` from some earlier
     * run — so the sweep found them idle on its very next tick and put them straight back offline,
     * once a minute, for ever. The users log said `presence swept offline=1` and nothing else was
     * obviously wrong.
     *
     * The product was right and the fixture was incomplete: "these agents are at their desks" has to
     * include *as of now*. Both calls go through the same repository the running service uses.
     */
    const repo = new PresenceRepository(scoped as never);
    const now = new Date();
    let onlined = 0;
    for (const authUserId of SEED_PRESENCE_ONLINE_USER_IDS) {
      await repo.touch(SEED_ACCOUNT_ID, authUserId, now);
      const out = await presence.setState(SEED_ACCOUNT_ID, authUserId, 'online', 'manual', {
        actorRef: authUserId,
      });
      if (out.status === 'ok') onlined += 1;
    }

    /**
     * ── Feature 026 (roadmap 5.7): ONE attachment, through the product's own write path ──────────
     *
     * ⭐ Its purpose is to make the NARROWING exercisable rather than hidden. With no attachment at
     * all, every AM read in a seeded database returns the narrowed answer and a live run cannot tell
     * "the narrowing works" from "the portfolio is empty". One attached player and one unattached is
     * the smallest fixture that distinguishes them.
     *
     * Through `AssignmentService`, never a direct insert: the seed then inherits the audit entry, the
     * refusals and the idempotence for free — a no-op re-seed writes nothing (FR-015). Writing the
     * row directly would be the feature-025 bug pre-installed: a state with no record of how it came
     * to be.
     */
    const assignments = new AssignmentService(
      new AssignmentRepository(scoped as never),
      new PlayerRepository(scoped as never),
      new OperatorRepository(scoped as never),
    );
    const assigned = await assignments.assign(
      SEED_ACCOUNT_ID,
      { brandId: SEED_BRAND_ID, playerId: SEED_PLAYER_ID },
      SEED_ROUTING_USER_IDS[0]!,
      SEED_AUTH_USER_ID,
    );

    console.log(
      `users seed: ok (${seed.players.length} players, incl. the cross-brand id collision; ` +
        `${seed.persons.length} person linking ${seed.personMembers.length} records; ` +
        `${seed.presenceLabels.length} presence labels; ${onlined} agents brought online, ` +
        `${SEED_PRESENCE_ONLINE_USER_IDS.length - onlined} already online; ` +
        `player↔AM attachment ${assigned.status})`,
    );
  } finally {
    await base.$disconnect();
  }
}

run().catch((err) => {
  console.error('users seed failed:', err);
  process.exit(1);
});
