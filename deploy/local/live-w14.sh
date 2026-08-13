#!/usr/bin/env bash
# MVP block W14 — live round (subpoints 3.8 + 3.9).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# ⭐⭐ THE BLOCK'S OWN CRITERION IS A [П+ТЕСТ] ONE: **changing a role changes ACCESS ON THE SERVER**,
# not the word printed beside somebody's name. So this round changes a role and then asks a
# DIFFERENT question with that person's own session: does the server now answer differently?
#
# The probe is `role-vip-support@beton.win` and the question is `GET /admin/access/users` — the
# people list, which needs `users.list.view`. VIP Support does not hold it; teamlead does. So:
#   refused → promote to teamlead → the SAME request now answers → demote → refused again.
# Nothing about the screen is asserted here; that is the browser check's job.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. It restores the original role at the end, so a second run
# starts from the same place — and if it dies half way, the first assertion of the next run says so
# instead of passing on a leftover state.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'
OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}"
OWNER_PW="${OWNER_PW:-m13aP1LLB07vyh#7A}"
# ⚠️⚠️ THE PROBE IS CHOSEN, NOT NAMED — and the first run of this script is why.
#
# It used `role-vip-support`, whose permissions an earlier block had PERSONALISED. The moment
# anybody is personalised their set becomes a standalone SNAPSHOT (ADR 0034), so a role change
# stops moving their access at all — and the round failed on an assertion that was right about the
# product and wrong about the fixture. The probe is now whichever role login still INHERITS its
# role, read from the database before anything is asserted.
PROBE_CANDIDATES="role-am@beton.win role-shift-am@beton.win role-vip-support@beton.win role-support-agent@beton.win"
ACC=seed-account-0000-0000-000000000001

ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

login(){ # $1 email, $2 password
  local ch code jar
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  echo "$jar"
}

# `users.list.view` is what the people list needs; asking for it IS the access question.
peopleList(){ curl -s -o /dev/null -w '%{http_code}' -b "$1" "$G/admin/access/users?pageSize=5"; }

# ── preflight ─────────────────────────────────────────────────────────────────────────────────────
PROBE=""; PROBE_ID=""; START_ROLE=""
for cand in $PROBE_CANDIDATES; do
  id=$(psql auth_db "select id from \"User\" where email='$cand'")
  [ -n "$id" ] || continue
  mode=$(psql auth_db "select coalesce(mode,'inherited') from \"UserPermissionSet\" where user_id='$id'")
  role=$(psql auth_db "select r.key from \"UserRole\" ur join \"Role\" r on r.id=ur.role_id where ur.user_id='$id'")
  # Must still INHERIT (see the note above) and must not already hold the key we test for.
  if [ "${mode:-inherited}" != "standalone" ] && [ "$role" != "teamlead" ] && [ "$role" != "admin" ]; then
    PROBE="$cand"; PROBE_ID="$id"; START_ROLE="$role"; break
  fi
done
[ -n "$PROBE_ID" ] && pass "preflight: probing as $PROBE (role '$START_ROLE', still INHERITS it)" \
  || { fail "preflight: an inheriting probe" "every candidate is personalised or already senior"; echo "W14 live: $ok ok, $bad failed"; exit 1; }

JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JOWNER" && pass "owner session (only a super-admin may change a role)" \
  || { fail "owner session" "no cookie"; echo "W14 live: $ok ok, $bad failed"; exit 1; }

# ── 1. the people list exists at all (it did not, before this block) ──────────────────────────────
OWNERLIST=$(curl -s -b "$JOWNER" "$G/admin/access/users?pageSize=5")
case "$OWNERLIST" in
  *'"users"'*'"email"'*) pass "⭐ GET /admin/access/users answers — the product can name its own people" ;;
  *) fail "people list" "${OWNERLIST:0:140}" ;;
esac
case "$OWNERLIST" in
  *'"roleKey"'*) pass "…and each person carries their role" ;;
  *) fail "role on the wire" "${OWNERLIST:0:140}" ;;
esac
# ⛔ Staff facts only — no customer data may ride a staff surface.
case "$OWNERLIST" in
  *playerId*|*player_id*|*segment*) fail "⛔ customer data on the staff list" "${OWNERLIST:0:140}" ;;
  *) pass "⛔ no customer field appears on the staff list" ;;
esac

# ── 2. ⭐⭐ the criterion: a role change moves ACCESS ──────────────────────────────────────────────
JPROBE=$(login "$PROBE" "$ROLE_PW")
BEFORE=$(peopleList "$JPROBE")
[ "$BEFORE" = "403" ] && pass "as $START_ROLE the probe is REFUSED the people list (403)" \
  || fail "probe refused before" "http $BEFORE"

PROMOTE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/access/users/$PROBE_ID/role" \
  -H 'Content-Type: application/json' -d '{"roleKey":"teamlead","op":"assign"}')
case "$PROMOTE" in 200|201|204) pass "the owner promotes the probe to teamlead (http $PROMOTE)" ;;
  *) fail "promote" "http $PROMOTE" ;; esac

# The gateway caches effective permissions for 30s and invalidates on this write; wait past both.
sleep 33
AFTER=$(peopleList "$JPROBE")
if [ "$AFTER" = "200" ]; then
  pass "⭐⭐ THE SAME SESSION now answers 200 — the role change moved ACCESS, not a label"
else
  fail "access moved with the role" "http $AFTER (was $BEFORE)"
fi

# ── 3. and back — the change is reversible, and the refusal returns ───────────────────────────────
DEMOTE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/access/users/$PROBE_ID/role" \
  -H 'Content-Type: application/json' -d "{\"roleKey\":\"$START_ROLE\",\"op\":\"assign\"}")
case "$DEMOTE" in 200|201|204) pass "the owner restores $START_ROLE (http $DEMOTE)" ;;
  *) fail "demote" "http $DEMOTE" ;; esac
sleep 33
RESTORED=$(peopleList "$JPROBE")
[ "$RESTORED" = "403" ] && pass "…and the refusal comes back — access follows the role in both directions" \
  || fail "access restored" "http $RESTORED"

# ── 4. the change is audited, both times ──────────────────────────────────────────────────────────
AUD=$(psql auth_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='role.assign' and target_ref='$PROBE_ID' and created_at > now() - interval '5 minutes'")
[ "${AUD:-0}" -ge 2 ] && pass "both role changes are audited ($AUD entries in the last five minutes)" \
  || fail "role changes audited" "entries=$AUD"

# ── 5. desks: the membership engine answers, and a member is an ID ────────────────────────────────
# ⚠️ Read from the FILE with grep rather than matching an interpolated variable: two earlier
# versions of these lines produced the diagnostic "1000" — a message naming neither the status nor
# the body. A pattern test that cannot say what it saw is not a check.
GSTATUS=$(curl -s -o /tmp/w14.groups -w '%{http_code}' -b "$JOWNER" "$G/groups")
if [ "$GSTATUS" = "200" ] && grep -q '"groups"' /tmp/w14.groups; then
  pass "the desks list answers"
else
  fail "groups list" "http $GSTATUS — $(head -c 120 /tmp/w14.groups)"
fi
GID=$(grep -o '"id":"[^"]*"' /tmp/w14.groups | head -1 | cut -d'"' -f4)
if [ -n "$GID" ]; then
  MEMBERS=$(curl -s -b "$JOWNER" "$G/groups/$GID/members")
  case "$MEMBERS" in
    *'"userIds"'*) pass "a desk's membership answers with USER IDS (no names are stored there)" ;;
    *) fail "group members" "${MEMBERS:0:140}" ;;
  esac
  ADD=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/groups/$GID/members/$PROBE_ID")
  case "$ADD" in 200|201|204) pass "adding a member is accepted (idempotent PUT)" ;; *) fail "add member" "http $ADD" ;; esac
  AGAIN=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/groups/$GID/members/$PROBE_ID")
  case "$AGAIN" in 200|201|204) pass "…and adding twice is the same answer — idempotent, not a conflict" ;; *) fail "idempotent add" "http $AGAIN" ;; esac
  DEL=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X DELETE "$G/groups/$GID/members/$PROBE_ID")
  case "$DEL" in 200|204) pass "removing the member restores the desk" ;; *) fail "remove member" "http $DEL" ;; esac
else
  fail "a desk to test membership on" "none returned"
fi

echo
echo "W14 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
