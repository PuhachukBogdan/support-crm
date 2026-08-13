#!/usr/bin/env bash
# MVP block W20 — live round (subpoints 6.2 + 6.3 + 6.4): the numbers are ALIVE.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The claim worth the round: the dashboard reads reality, not a cache — CREATE one conversation
# through the product and watch «создано сегодня», «в работе» and today's bar each move by ONE.
# Deltas, never absolutes (the stand's history keeps supplying numbers). Plus the gate: an agent
# without `analytics.dashboard.view` gets a real 403.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Each run creates one outbound conversation (the W17 initiate
# path — the only product path that creates a ticket on demand); synthetic data doing its job.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'
OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}"
OWNER_PW="${OWNER_PW:-m13aP1LLB07vyh#7A}"

ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
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

num(){ # $1 json, $2 field
  echo "$1" | sed -n "s/.*\"$2\":\(-\{0,1\}[0-9]*\).*/\1/p" | head -1
}
today_bar(){ # $1 json — today's volume bucket count
  local today; today=$(date -u +%F)
  echo "$1" | tr '{' '\n' | grep "\"key\":\"$today\"" | sed -n 's/.*"count":\([0-9]*\).*/\1/p' | head -1
}

JLEAD=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JLEAD" && pass "a teamlead's session (the analytics viewer)" \
  || { fail "teamlead session" "no cookie"; echo "W20 live: $ok ok, $bad failed"; exit 1; }
JAGENT=$(login "role-support-agent@beton.win" "$ROLE_PW")
JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")

# ── 1. the snapshot answers, shaped ────────────────────────────────────────────────────────────────
S0=$(curl -s -b "$JLEAD" "$G/analytics/snapshot?days=14")
C0=$(num "$S0" createdToday); O0=$(num "$S0" openNow); B0=$(today_bar "$S0")
if [ -n "$C0" ] && [ -n "$O0" ] && echo "$S0" | grep -q '"volumeByDay"'; then
  pass "⭐ GET /analytics/snapshot answers (today $C0 created, $O0 in work)"
else
  fail "snapshot" "${S0:0:140}"
fi
DAYS=$(echo "$S0" | grep -o '"key":"20[0-9-]*"' | wc -l | tr -d ' ')
[ "$DAYS" = "14" ] && pass "…the day series is zero-filled to exactly the window (14 buckets)" \
  || fail "day buckets" "$DAYS buckets"

# ── 2. ⭐ the numbers MOVE with reality ────────────────────────────────────────────────────────────
PAIR=$(docker compose exec -T postgres psql -U postgres -d users_db -tAc "select brand_id || '|' || player_id from \"ChannelParticipant\" where kind='email' and player_id is not null limit 1" | tr -d '\r')
BR=${PAIR%%|*}; PL=${PAIR##*|}
NEW=$(curl -s -o /tmp/w20.init -w '%{http_code}' -b "$JOWNER" -X POST "$G/conversations/initiate-email" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BR\",\"playerId\":\"$PL\",\"body\":\"analytics probe $RANDOM\"}")
{ [ "$NEW" = "200" ] || [ "$NEW" = "201" ]; } && pass "one conversation created through the product" \
  || fail "create through the product" "http $NEW"
S1=$(curl -s -b "$JLEAD" "$G/analytics/snapshot?days=14")
C1=$(num "$S1" createdToday); O1=$(num "$S1" openNow); B1=$(today_bar "$S1")
[ "$((C1 - C0))" = "1" ] && pass "⭐ «создано сегодня» moved by exactly ONE ($C0 → $C1) — the number is alive" \
  || fail "createdToday delta" "$C0 → $C1"
[ "$((O1 - O0))" = "1" ] && pass "⭐ «в работе» moved with it ($O0 → $O1) — categories, not a cache" \
  || fail "openNow delta" "$O0 → $O1"
[ "$((B1 - B0))" = "1" ] && pass "⭐ …and today's BAR on the chart grew by one ($B0 → $B1)" \
  || fail "today's bar delta" "$B0 → $B1"

# ── 3. ⛔ the gate and the refusals ─────────────────────────────────────────────────────────────────
AG=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAGENT" "$G/analytics/snapshot")
[ "$AG" = "403" ] && pass "⛔ a line agent is REFUSED the dashboard (403 — server-side)" \
  || fail "agent refused" "http $AG"
BADDAYS=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" "$G/analytics/snapshot?days=zero")
[ "$BADDAYS" = "400" ] && pass "a non-numeric window is refused (400)" || fail "bad days refused" "http $BADDAYS"
CAP=$(curl -s -b "$JLEAD" "$G/analytics/snapshot?days=5000" | grep -o '"key":"20[0-9-]*"' | wc -l | tr -d ' ')
[ "$CAP" = "90" ] && pass "a 5000-day ask is answered as the 90-day cap — «прямо из журнала» honest about its limits" \
  || fail "window cap" "$CAP buckets"

echo
echo "W20 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
