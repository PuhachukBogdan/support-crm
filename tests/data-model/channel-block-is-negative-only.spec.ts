import { parseSchema, hasField, type Model } from './schema-scan';

/**
 * T041 (feature 025, roadmap 5.9 — FR-019): **a channel switch subtracts and never grants**, asserted
 * as a property of the SCHEMA rather than of the code that writes to it.
 *
 * ── ⭐ Why all three assertions live in ONE file ─────────────────────────────────────────────────
 * This product now has two tables that lean in OPPOSITE directions for reasons that are opposite in
 * exactly the same way:
 *
 *   • `GroupPermission` (feature 024) has no `granted` column — a group may only ever GRANT, so there
 *     is nothing to write `false` into.
 *   • `OperatorChannelBlock` (this feature) has no `available` column — a switch may only ever DENY,
 *     so there is nothing to write `true` into.
 *
 * Both are enforced by ABSENCE rather than by convention: "we never write the other value" holds
 * until the third feature needs an exception under a deadline, whereas "the column does not exist"
 * makes the violation unrepresentable.
 *
 * They are asserted together **so that copying one model to make the other fails**. Separately, each
 * file would pass while the pair drifted; and the third assertion — that `UserPermissionEntry` DOES
 * have `granted` — is what proves the detector can tell the difference at all, rather than reporting
 * "absent" for everything.
 */

function model(service: 'auth' | 'users', name: string): Model {
  const m = parseSchema(service).find((x) => x.name === name);
  if (!m) throw new Error(`${name} is missing from the ${service} schema`);
  return m;
}

/** Anything that would let a row express "available", a precedence, or an override. */
const FORBIDDEN = ['available', 'enabled', 'allowed', 'granted', 'effect', 'priority', 'weight'];

describe('a channel switch can only ever subtract (feature 025)', () => {
  it('scans schemas that actually contain the models (anti-vacuous)', () => {
    // Without this, every assertion below would pass just as happily against an empty parse.
    expect(parseSchema('users').map((m) => m.name)).toEqual(
      expect.arrayContaining(['OperatorChannelBlock', 'OperatorPresence']),
    );
    expect(parseSchema('auth').map((m) => m.name)).toEqual(
      expect.arrayContaining(['GroupPermission', 'UserPermissionEntry']),
    );
  });

  it.each(FORBIDDEN)('`OperatorChannelBlock` has no `%s` field', (field) => {
    expect(hasField(model('users', 'OperatorChannelBlock'), field)).toBe(false);
  });

  it('carries nothing but its three key columns and a timestamp — a row IS the block', () => {
    const scalars = model('users', 'OperatorChannelBlock')
      .fields.filter((f) => !f.isRelation)
      .map((f) => f.name)
      .sort();
    expect(scalars).toEqual(['account_id', 'auth_user_id', 'channel', 'created_at']);
  });

  it('⭐ the MIRROR still holds: a group may only GRANT, so it has no `granted`', () => {
    // If this ever fails together with the block assertions above, somebody copied one model to make
    // the other — which is precisely the accident this file exists to catch.
    expect(hasField(model('auth', 'GroupPermission'), 'granted')).toBe(false);
  });

  it('and the per-user SNAPSHOT still DOES have `granted` — so the detector can tell them apart', () => {
    // A materialised snapshot of one person's permissions must be able to say "explicitly not".
    // Proving the difference is visible is what makes the two absences above meaningful.
    expect(hasField(model('auth', 'UserPermissionEntry'), 'granted')).toBe(true);
  });

  it('presence itself stores no `available` either — availability is DERIVED', () => {
    // There are TWO asks (a new push versus a human transfer) and `transfers_only` answers them
    // differently, so a single stored boolean could not be correct for both — and it would be the
    // copy that goes stale.
    for (const field of ['available', 'is_available', 'can_receive']) {
      expect(hasField(model('users', 'OperatorPresence'), field)).toBe(false);
    }
  });

  it('presence keeps `last_cause`, which is what makes the heartbeat rule decidable', () => {
    // The one place this feature deliberately stores a fact that also lives in the history. FR-016
    // needs "how did this state come to be?" on the hottest write path, and scanning an append-only
    // stream per heartbeat is not that.
    expect(hasField(model('users', 'OperatorPresence'), 'last_cause')).toBe(true);
  });
});
