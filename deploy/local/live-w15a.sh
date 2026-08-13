#!/usr/bin/env bash
# MVP block W15a — live round (subpoint 3.14): the status authoring screen's wire.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# ⭐⭐ THE CLAIM WORTH A LIVE ROUND: feature 032's model made this screen an INSERT — so a status
# created HERE must be settable on a real conversation IMMEDIATELY, through the ordinary agent path,
# with no deploy and no code change (the composite-FK property). And its mirror: the moment it is
# retired, the same set is REFUSED — a retired status is indistinguishable from an unknown one at
# every write.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. The probe status name is unique per run and the row is RETIRED at
# the end (retirement is the model's cleanup — deletion does not exist); each run leaves one retired
# `w15a_probe_*` row on the stand, which is synthetic data doing its job.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'
OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}"
OWNER_PW="${OWNER_PW:-m13aP1LLB07vyh#7A}"
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

audits(){ psql chats_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='status.config_changed'"; }

JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JOWNER" && pass "owner session" \
  || { fail "owner session" "no cookie"; echo "W15a live: $ok ok, $bad failed"; exit 1; }
JLEAD=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JLEAD" && pass "teamlead session (the negative-control caller)" || fail "teamlead session" "no cookie"

# ── 1. the catalogue read carries BOTH names (the screen's read is 032's own route) ───────────────
CAT=$(curl -s -b "$JOWNER" "$G/conversations/statuses")
case "$CAT" in
  *'"statuses"'*'"endUserName"'*) pass "the catalogue answers with dual names (agent + end-user)" ;;
  *) fail "catalogue read" "${CAT:0:140}" ;;
esac

# ── 2. ⛔ the invariant: the vocabulary is refused below the configuration key ─────────────────────
LEADPOST=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" -X POST "$G/admin/statuses" \
  -H 'Content-Type: application/json' -d '{"category":"open","agentName":"Intruder","endUserName":"X"}')
[ "$LEADPOST" = "403" ] && pass "⛔ a teamlead may not CREATE a status (403 — server-side)" \
  || fail "teamlead create refused" "http $LEADPOST"
LEADPATCH=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" -X PATCH "$G/admin/statuses/open" \
  -H 'Content-Type: application/json' -d '{"agentName":"Intruder"}')
[ "$LEADPATCH" = "403" ] && pass "⛔ …nor EDIT one (403)" || fail "teamlead edit refused" "http $LEADPATCH"

# ── 3. ⭐ create — the key is derived, the write audited ───────────────────────────────────────────
SUFFIX=$RANDOM
NAME="W15a Probe $SUFFIX"
KEY="w15a_probe_$SUFFIX"
A0=$(audits)
CREATE=$(curl -s -o /tmp/w15a.create -w '%{http_code}' -b "$JOWNER" -X POST "$G/admin/statuses" \
  -H 'Content-Type: application/json' -d "{\"category\":\"pending\",\"agentName\":\"$NAME\",\"endUserName\":\"In review\"}")
if [ "$CREATE" = "201" ] && grep -q "\"key\":\"$KEY\"" /tmp/w15a.create; then
  pass "⭐ created '$NAME' — the key is the name normalised ($KEY), never chosen"
else
  fail "create status" "http $CREATE — $(head -c 120 /tmp/w15a.create)"
fi
A1=$(audits)
[ "$((A1 - A0))" = "1" ] && pass "…audited, exactly once (status.config_changed +1)" || fail "audit on create" "delta $((A1 - A0))"

# ── 4. ⭐⭐ the composite-FK property, live: the new word is LEGAL IMMEDIATELY ──────────────────────
CONV=$(curl -s -b "$JOWNER" "$G/conversations?pageSize=1")
CID=$(echo "$CONV" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
PREV=$(echo "$CONV" | sed -n 's/.*"statusKey":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$CID" ] && [ -n "$PREV" ]; then
  pass "a real conversation to probe with ($CID, currently '$PREV')"
else
  fail "a conversation to probe with" "id='$CID' status='$PREV'"
fi
SET=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/conversations/$CID/status" \
  -H 'Content-Type: application/json' -d "{\"status\":\"$KEY\"}")
[ "$SET" = "200" ] && pass "⭐⭐ the status created a moment ago is SETTABLE on a real ticket — an INSERT, no deploy" \
  || fail "new status settable" "http $SET"
RESTORE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/conversations/$CID/status" \
  -H 'Content-Type: application/json' -d "{\"status\":\"$PREV\"}")
[ "$RESTORE" = "200" ] && pass "…and the ticket is restored to '$PREV'" || fail "restore ticket status" "http $RESTORE"

# ── 5. edit: rename + category move; a no-op refused with nothing written ─────────────────────────
EDIT=$(curl -s -o /tmp/w15a.edit -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/admin/statuses/$KEY" \
  -H 'Content-Type: application/json' -d "{\"agentName\":\"$NAME v2\",\"category\":\"on_hold\"}")
if [ "$EDIT" = "200" ] && grep -q "\"agentName\":\"$NAME v2\"" /tmp/w15a.edit && grep -q 'ON_HOLD' /tmp/w15a.edit; then
  pass "⭐ renamed and MOVED CATEGORY in one edit — re-bucketing is one data row, never code"
else
  fail "edit status" "http $EDIT — $(head -c 140 /tmp/w15a.edit)"
fi
A2=$(audits)
[ "$((A2 - A1))" = "1" ] && pass "…audited, exactly once" || fail "audit on edit" "delta $((A2 - A1))"
NOOP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/admin/statuses/$KEY" \
  -H 'Content-Type: application/json' -d "{\"agentName\":\"$NAME v2\"}")
A3=$(audits)
if [ "$NOOP" = "400" ] && [ "$A3" = "$A2" ]; then
  pass "the same words sent back are refused (400) and write nothing"
else
  fail "no-op refused" "http $NOOP, audit delta $((A3 - A2))"
fi

# ── 6. ⭐ retire — and the mirror of §4: the same set is now REFUSED ───────────────────────────────
RETIRE=$(curl -s -o /tmp/w15a.retire -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/admin/statuses/$KEY" \
  -H 'Content-Type: application/json' -d '{"active":false}')
if [ "$RETIRE" = "200" ] && grep -q '"active":false' /tmp/w15a.retire; then
  pass "the probe status is retired (active:false — an update, not a delete)"
else
  fail "retire" "http $RETIRE — $(head -c 120 /tmp/w15a.retire)"
fi
SETRETIRED=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PATCH "$G/conversations/$CID/status" \
  -H 'Content-Type: application/json' -d "{\"status\":\"$KEY\"}")
[ "$SETRETIRED" = "400" ] && pass "⭐ …and the SAME set that succeeded in §4 is now refused — retired = unknown at every write" \
  || fail "retired not settable" "http $SETRETIRED"
STILL=$(curl -s -b "$JOWNER" "$G/conversations/statuses")
case "$STILL" in
  *"$KEY"*) pass "…while the row still renders in the catalogue (old tickets keep their label)" ;;
  *) fail "retired row still readable" "key gone from the catalogue" ;;
esac

# ── 7. the key is an identity: the same name again CONFLICTS, even against a retired row ──────────
DUP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X POST "$G/admin/statuses" \
  -H 'Content-Type: application/json' -d "{\"category\":\"pending\",\"agentName\":\"$NAME\",\"endUserName\":\"X\"}")
[ "$DUP" = "409" ] && pass "⛔ the same name again is a CONFLICT (409) — retirement is not deletion" \
  || fail "duplicate name conflicts" "http $DUP"

echo
echo "W15a live: $ok ok, $bad failed"
[ "$bad" = "0" ]
