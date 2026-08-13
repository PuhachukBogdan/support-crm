#!/usr/bin/env bash
# Bring a test host to a KNOWN state, so a live (Track B) run starts from something
# reproducible instead of guessing what is already there.
#
# ── Why this exists ──────────────────────────────────────────────────────────────────────────────
# Feature 018's first live run reported **22 failures and not one was a product defect**: `users_db`
# had never been seeded on that host, so every read answered a correct 404 and the script blamed the
# code. Each feature's `track-b.sh` had been re-discovering host state on its own, and the knowledge
# of HOW to prepare a host lived in prose across several session notes. It lives here now.
#
# Idempotent by construction: migrations are `deploy` (skip what is applied), seeds are upserts on
# stable keys. Running it twice changes nothing the second time — that property is what makes it
# safe to run before every live session.
#
# Usage, on the test host:   bash deploy/local/prepare-test-server.sh
# Or from a dev box:         ssh beton-test 'cd ~/crm && bash deploy/local/prepare-test-server.sh'
set -uo pipefail
cd "$(dirname "$0")/../.."   # repo root

DATA_SERVICES="auth users brands chats"
OK=0; FAIL=0
step() { echo; echo "── $1"; }
ok()   { OK=$((OK+1));   echo "   ok    $1"; }
bad()  { FAIL=$((FAIL+1)); echo "   FAIL  $1"; }
psqlq(){ docker compose exec -T postgres psql -qtAX -U postgres -d "$1" -c "$2" 2>/dev/null; }

# The Track-B login password for the seeded account. Needed because `seed:auth` writes a PLACEHOLDER
# hash (feature 008 ships no password-set surface), so a freshly seeded host always has an unusable
# login — and re-running `seed:auth` later to "fix" one OVERWRITES a working hash.
#
# ⚠️ THE HASH IS DERIVED, NEVER HARDCODED, and that is a scar. The first draft of this script pasted a
# hash constant copied from a track-b script — but that constant is the hash of the emailed **CODE**
# (`ABCD23`), not of the password, and writing it into `Credential.secret_hash` **broke the login**.
# Two lookalike hashes in the same file is a trap; deriving removes it entirely. Same value must match
# `PASS` in `specs/*/track-b.sh`.
#
# Synthetic fixture for a synthetic account on a synthetic-data-only host. Not a credential for
# anything real. Satisfies the password policy (min 6 + upper + digit + symbol).
TRACKB_PASSWORD='TrackB-017-Passw0rd!'
SEED_EMAIL='admin@example.test'
# ⭐ Overridable since 2026-08-07 (Шаг 0): there are now TWO stands on this host — the frozen public
# one and the verification one — and they publish on different loopback addresses so their ports do
# not collide. The script must be able to address either.
#   frozen:        GW unset            → http://localhost:3000
#   verification:  GW=http://127.0.0.2:3000
# ⚠️ Pair it with the compose selectors, or this prepares the WRONG stand:
#   COMPOSE_PROJECT_NAME=crm-next COMPOSE_FILE=compose.yaml:compose.next.yaml
GW="${GW:-http://localhost:3000}"

step "1/6  docker compose up (build if needed)"
if docker compose up -d --build >/dev/null 2>&1; then ok "stack is up"; else bad "compose up failed — stopping"; exit 1; fi

step "2/6  waiting for postgres to accept connections"
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 2
done
if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then ok "postgres ready"; else bad "postgres never became ready"; exit 1; fi

step "3/6  migrations — one per data service"
# ⚠️ `--schema` is MANDATORY inside the container. Without it `migrate deploy` reports
# "no pending migrations" against the WRONG schema and the next step fails on a missing table.
# ⚠️ `docker compose run` SWALLOWS STDIN, which kills any heredoc that follows — hence `< /dev/null`.
for s in $DATA_SERVICES; do
  if docker compose run --rm "$s" npx prisma migrate deploy \
       --schema "services/$s/prisma/schema.prisma" < /dev/null >/dev/null 2>&1; then
    ok "$s migrations applied"
  else
    bad "$s migrations FAILED — run it by hand to see why"
  fi
done

step "4/6  seeds — synthetic, brand-neutral, idempotent (upsert on stable keys)"
for s in $DATA_SERVICES; do
  if docker compose run --rm "$s" npm run "seed:$s" < /dev/null >/dev/null 2>&1; then
    ok "$s seeded"
  else
    bad "$s seed FAILED"
  fi
done

step "5/6  making the seeded login usable"
# See the note on TRACKB_HASH above: the seed writes a placeholder, so this MUST run after seeding
# and must not be skipped just because the seed succeeded.
# Hash computed by the service that will verify it — same library, same parameters, no chance of a
# mismatch. ⚠️ The column is `secret_hash`, NOT `password_hash`; the first draft guessed the latter and
# reported a failure that was its own (see services/auth/prisma/schema.prisma → Credential).
HASH=$(docker compose run --rm -e P="$TRACKB_PASSWORD" auth \
         node -e "require('argon2').hash(process.env.P).then(h=>process.stdout.write(h))" \
         < /dev/null 2>/dev/null | tr -d '\r\n')
case "$HASH" in
  '$argon2'*) ok "password hash derived by the auth service" ;;
  *)          bad "could not derive a hash (got: ${HASH:0:40}) — stopping"; echo; exit 1 ;;
esac

if psqlq auth_db "update \"Credential\" set secret_hash='$HASH'
                  where user_id in (select id from \"User\" where email='$SEED_EMAIL');" >/dev/null; then
  ok "hash written for $SEED_EMAIL"
else
  bad "could not write the hash"
fi

# ⚠️ AND THEN ACTUALLY LOG IN. This step exists because the first version of this script wrote a WRONG
# hash, declared success, and the breakage surfaced in the next live run — which is precisely the
# failure mode this whole script exists to prevent. A precondition that is not exercised is a guess.
LOGIN=$(curl -s -X POST "$GW/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"$TRACKB_PASSWORD\"}" 2>/dev/null)
case "$LOGIN" in
  *challengeId*) ok "the seeded account can actually log in (step 1 of 2 answered)" ;;
  *)             bad "LOGIN DOES NOT WORK: $LOGIN" ;;
esac

step "6/6  verifying the fixtures a live run depends on"
# Each of these is something a Track B script would otherwise mistake for a product defect.
check() { local db=$1 q=$2 want=$3 what=$4; local got; got=$(psqlq "$db" "$q"); \
  if [ "$got" = "$want" ]; then ok "$what"; else bad "$what — expected [$want], got [$got]"; fi; }

check auth_db   "select count(*) from \"User\" where email='$SEED_EMAIL';"                     1 "auth: the seeded operator account exists"
check auth_db   "select count(*) > 50 from \"RolePermission\";"                                t "auth: role permission defaults are seeded"

# Roles are checked BY KEY, not by count. ⚠️ Counting was the first draft and it was wrong twice over:
# it failed on a host that had 8 rows, and it would have passed on a host with 7 WRONG ones.
CATALOGUE_ROLES="support_agent vip_support am shift_am teamlead admin super_admin"
for r in $CATALOGUE_ROLES; do
  check auth_db "select count(*) from \"Role\" where key='$r';" 1 "auth: role '$r' exists"
done

# Extra roles are REPORTED, not failed and not deleted.
#   * Not failed: a leftover row from an earlier live run does not stop a live run from being valid.
#   * Not deleted: a `UserRole` may point at it (the `agent@` fixture pointed at exactly this one), so
#     removing it silently would break a fixture to tidy a warning.
# Known instance: a Role with an EMPTY key, created by feature 011's live run *before* invites started
# validating `role_key` against the catalogue. The product can no longer create it; the row survives on
# hosts seeded back then. Harmless — an unknown role key falls back to open-only tiers (fail-closed).
EXTRA=$(psqlq auth_db "select coalesce(string_agg(coalesce(nullif(key,''),'<empty>'), ', '), '') from \"Role\"
                       where key not in ('support_agent','vip_support','am','shift_am','teamlead','admin','super_admin');")
if [ -n "$EXTRA" ]; then
  echo "   note  auth: roles outside the catalogue present: $EXTRA"
  echo "         Leftover from an earlier live run, not a product defect and not fail-closed-unsafe."
  echo "         Remove only after checking \"UserRole\" does not reference it."
fi
# ⚠️ Both of these asserted `= 1` until 2026-08-07 and both were WRONG, in the two different ways this
# file already warns about elsewhere. Caught while preparing the second stand (Шаг 0); the frozen
# public stand — which passed W21's live round 16/16 twice — reports the same numbers, which is what
# proves the assertions were stale rather than the hosts broken.
#
#   * Player: `seed-player-001` legitimately has **one row per brand**. ADR 0038 §3 is explicit —
#     the same player id under another brand is ANOTHER HUMAN, and the seed creates two brands' worth.
#     So `= 1` encoded a single-brand world that stopped existing. Asserting per-brand presence is the
#     honest form; the count alone cannot say it.
#   * Operator: a live host ACCUMULATES operators — role logins, invites completed during live rounds,
#     registrations. `= 1` described a host that had only ever been seeded, i.e. a host on its first
#     day. The property wanted here is "seeding produced the operator a live run needs", not "nobody
#     has ever used this host".
#     ⚠️ And the first attempt at THIS fix was wrong too, recorded so it is not retried: comparing the
#     player's distinct brand ids against `count(*)` from `Brand` fails on a healthy host, because
#     `brands_db` holds one Brand row while `users_db` stores brand ids as VALUES across two — the
#     services do not join (ADR 0029). The check would have been red for a reason it does not name.
check users_db  "select count(*) >= 1 from \"Player\" where player_id='seed-player-001';"      t "users: the seeded player exists (one row per brand by design)"
check users_db  "select count(*) >= 1 from \"Operator\";"                                      t "users: at least one operator exists (a live host accumulates more)"
# ⚠️ W30: `count(*) = 1` broke on crm-next the way the users comment above predicts — a live host
# accumulates (BOW2 arrived through the product in an earlier round), and the check went red for a
# reason it does not name. The assertion now asks what its NAME always claimed: the SEEDED brand exists.
check brands_db "select count(*) >= 1 from \"Brand\" where id='seed-brand-0000-0000-000000000001';" t "brands: the seeded brand exists"
check chats_db  "select count(*) > 0 from \"Conversation\";"                                    t "chats: seeded conversations exist"

step "clearing the gateway's effective-permission cache"
# The gateway caches resolved permissions in Redis for 30s. Anything that edited auth_db directly
# above fired no invalidation, so a live run started right now could read a stale answer and report
# it as a product defect (feature 017's first run did exactly that).
docker compose exec -T redis redis-cli --scan --pattern 'rbac:eff:*' 2>/dev/null \
  | xargs -r -n50 docker compose exec -T redis redis-cli DEL >/dev/null 2>&1
ok "permission cache dropped"

echo
echo "================================================================"
echo "  READY: $OK    PROBLEMS: $FAIL"
echo "================================================================"
if [ "$FAIL" -ne 0 ]; then
  echo "Do NOT start a live run — its failures would describe this host, not the product."
  exit 1
fi
echo "Host is in a known state. Live scripts may run."
