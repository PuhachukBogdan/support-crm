#!/usr/bin/env bash
# MVP block W16 — live round (subpoints 3.11 + 3.12): the tag registry and the audit table's wire.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# Two claims worth a live round:
#   ⭐ the tag COUNT reflects reality — attach a label through the product's own path and the
#     registry's number moves by exactly one, detach and it moves back;
#   ⭐ reading the audit log IS ITSELF RECORDED — feature 015's marquee property, observable through
#     the product for the first time: one GET /audit → exactly one new `audit.read` entry.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Every write this round makes is reversed in the same run
# (attach → detach), and delta-assertions never read absolutes — the log grows by design.
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

# The registry's count for ONE label id, from the product's own read.
count_of(){ # $1 jar, $2 labelId
  curl -s -b "$1" "$G/labels/usage" | sed -n "s/.*\"id\":\"$2\"[^}]*\"usageCount\":\([0-9]*\).*/\1/p" | head -1
}

JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JOWNER" && pass "owner session" \
  || { fail "owner session" "no cookie"; echo "W16 live: $ok ok, $bad failed"; exit 1; }
JLEAD=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JLEAD" && pass "teamlead session (the audit negative-control caller)" || fail "teamlead session" "no cookie"

# ── 1. ⭐ the tag registry answers, and its count MOVES with reality ───────────────────────────────
USAGE=$(curl -s -b "$JOWNER" "$G/labels/usage")
case "$USAGE" in
  *'"labels"'*'"usageCount"'*) pass "⭐ GET /labels/usage answers — every tag with its count" ;;
  *) fail "tag registry" "${USAGE:0:140}" ;;
esac
NOSESSION=$(curl -s -o /dev/null -w '%{http_code}' "$G/labels/usage")
[ "$NOSESSION" = "401" ] && pass "⛔ without a session the registry refuses (401)" || fail "registry unauthenticated" "http $NOSESSION"

LABEL=$(curl -s -b "$JOWNER" "$G/labels" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
CONV=$(curl -s -b "$JOWNER" "$G/conversations?pageSize=1" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$LABEL" ] && [ -n "$CONV" ]; then
  pass "a label ($LABEL) and a conversation to move the count with"
else
  fail "fixtures for the delta" "label='$LABEL' conv='$CONV'"
fi
# The pair may already be LINKED by the seed. Measure before touching anything, so the run can
# put the link back exactly as it found it — a live round must not quietly edit the fixture.
CPRE=$(count_of "$JOWNER" "$LABEL")
curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/conversations/$CONV/labels/$LABEL"
C0=$(count_of "$JOWNER" "$LABEL")
WAS_LINKED=$((CPRE - C0))
ATTACH=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/conversations/$CONV/labels/$LABEL")
C1=$(count_of "$JOWNER" "$LABEL")
if [ "$ATTACH" = "200" ] || [ "$ATTACH" = "201" ] || [ "$ATTACH" = "204" ]; then
  [ "$((C1 - C0))" = "1" ] && pass "⭐ attach through the product moved the count by ONE ($C0 → $C1)" \
    || fail "count follows attach" "was $C0, now $C1"
else
  fail "attach" "http $ATTACH"
fi
if [ "$WAS_LINKED" = "1" ]; then
  # The link existed before the round — leaving it attached IS the restore.
  [ "$C1" = "$CPRE" ] && pass "…and the pair is back exactly where the seed had it ($CPRE)" \
    || fail "restore (was linked)" "pre $CPRE, now $C1"
else
  curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/conversations/$CONV/labels/$LABEL"
  C2=$(count_of "$JOWNER" "$LABEL")
  [ "$C2" = "$CPRE" ] && pass "…and detach put it back where it started ($C1 → $C2)" \
    || fail "restore (was unlinked)" "pre $CPRE, now $C2"
fi

# ── 2. ⭐ the audit log answers — and READING IT IS RECORDED ───────────────────────────────────────
R0=$(psql auth_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='audit.read'")
AUDIT=$(curl -s -b "$JOWNER" "$G/audit?pageSize=5")
case "$AUDIT" in
  *'"entries"'*'"action"'*) pass "⭐ GET /audit answers — the trail written since April is readable" ;;
  *) fail "audit read" "${AUDIT:0:140}" ;;
esac
R1=$(psql auth_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='audit.read'")
[ "$((R1 - R0))" = "1" ] && pass "⭐ …and that read wrote exactly ONE audit.read entry — the reader is on the record too" \
  || fail "audit.read recorded" "delta $((R1 - R0))"

# The class filter narrows to real rows (the W15/W15a rounds wrote assignment-class entries).
FILTERED=$(curl -s -b "$JOWNER" "$G/audit?actionClass=assignment&pageSize=5")
case "$FILTERED" in
  *'"entries":['*'"action"'*) pass "the actionClass filter answers with entries (assignment has real rows)" ;;
  *) fail "class filter" "${FILTERED:0:140}" ;;
esac
BADCLASS=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" "$G/audit?actionClass=nope")
[ "$BADCLASS" = "400" ] && pass "an unknown class is REFUSED (400), never silently widened" \
  || fail "unknown class refused" "http $BADCLASS"

# ── 3. ⛔ the invariant: the log is refused below platform.audit.view ──────────────────────────────
LEAD=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" "$G/audit?pageSize=5")
[ "$LEAD" = "403" ] && pass "⛔ a teamlead is REFUSED the audit log (403 — server-side)" \
  || fail "teamlead refused audit" "http $LEAD"

echo
echo "W16 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
