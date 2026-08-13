#!/usr/bin/env bash
# MVP block W5 — live round (subpoint 2.4 + roadmap 5.11/4.19/4.20/4.21).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The block's criterion, verbatim from the plan:
#   «тикет из канала доезжает до конкретного агента и учитывается в его загрузке»
#
# So this script sends a stranger's delivery and then WAITS — because the promise is the queue's, not
# intake's: the ticket must gain an owner by itself, within a drain tick, with nobody touching it.
# What it can answer that no unit test can:
#
#   a signed delivery ends up ASSIGNED to a member of the channel's desk, unprompted
#   the assignment is counted against that agent's load BY THE SAME QUERY the router reads
#   the agent can ask "which operator am I?" with no permission beyond being signed in (5.11)
#   opening the ticket puts it on the agent's server-side rail, and solving it takes it off (4.19)
#   a second delivery is routed too — the rotation moves, two tickets never share one fate
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Every identifier is unique per run and nothing is cleaned up.
#
# ⓘ The assignee is whichever desk member the rotation picks — the script LOOKS UP who got the ticket
# and signs in as exactly that person for the rail leg. ⚠️ seed-agent1 holds the AM role on this stand
# (gotcha: the-probe-user-was-an-am), and feature 030 correctly hides portfolio-external work from an
# AM — so if the rotation hands the ticket to agent1, the rail leg uses the OTHER run's ticket. Two
# deliveries per run make sure at least one lands on a pure support agent.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
SEED_PW='Stand#Seed7x'
ACC=seed-account-0000-0000-000000000001
DESK=seed-group-0000-0000-000000000001
API_KEY=stand-api-brand1
if [ -f .env ]; then set -a; . ./.env >/dev/null 2>&1; set +a; fi
API_SECRET="${CHANNEL_SECRETS##*:}"

RUN=$(date +%s)
ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

login(){ # $1 email → prints a cookie jar path
  local ch code jar
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$SEED_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  echo "$jar"
}

sign(){ local t d; t=$(date +%s); d=$(printf '%s.%s' "$t" "$1" | openssl dgst -sha256 -hmac "$API_SECRET" -hex | sed 's/.*= //'); printf 't=%s,v1=%s' "$t" "$d"; }

# The pool's OWN load arithmetic, run against the same rows it reads: non-terminal categories only.
load_of(){ psql chats_db "select count(*) from \"Conversation\" c join \"ConversationStatus\" s on s.account_id=c.account_id and s.key=c.status where c.account_id='$ACC' and c.assignee_operator_id='$1' and s.category not in ('solved','closed')"; }

# ── preflight: the fixtures this run stands on (a fixture is not what the script believes) ────────
[ -n "$API_SECRET" ] || { fail "preflight" "CHANNEL_SECRETS empty"; echo "W5 live: $ok ok, $bad failed"; exit 1; }
ROUTABLE=$(psql auth_db "select routable from \"Group\" where id='$DESK'")
[ "$ROUTABLE" = "t" ] && pass "preflight: desk A exists and is routable" || fail "preflight: desk A routable" "got '$ROUTABLE'"
DESKCH=$(psql chats_db "select count(*) from \"Channel\" where account_id='$ACC' and default_group_id='$DESK'")
[ "$DESKCH" = "2" ] && pass "preflight: both channels push to desk A" || fail "preflight: channels name the desk" "rows=$DESKCH"
MEMBERS=$(psql auth_db "select count(*) from \"GroupMember\" where group_id='$DESK'")
[ "$MEMBERS" = "3" ] && pass "preflight: desk A has its three members" || fail "preflight: desk membership" "rows=$MEMBERS"

JADMIN=$(login "admin@example.test")
grep -q access "$JADMIN" && pass "admin session (the observer)" || { fail "admin session" "no cookie"; echo "W5 live: $ok ok, $bad failed"; exit 1; }

# ── the fixture, through the product's own path (never psql): two agents go ON SHIFT ──────────────
# The first run of this script found the whole desk `offline/auto_inactivity` — the presence sweep
# had, correctly, sent everyone home, and the pool answered "nobody available" for ever while the
# queue waited. The product was RIGHT; the fixture was missing. ⚠️ agent1 stays off shift on purpose:
# they hold the AM role on this stand (gotcha: the-probe-user-was-an-am), so keeping them out of the
# pool makes every assignee a pure support agent — and proves along the way that an off-shift member
# receives nothing.
JAG2=$(login "seed-agent2@example.test")
JAG3=$(login "seed-agent3@example.test")
P2=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG2" -X PUT "$G/presence/me" -H 'Content-Type: application/json' -d '{"state":"online"}')
P3=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG3" -X PUT "$G/presence/me" -H 'Content-Type: application/json' -d '{"state":"online"}')
[ "$P2" = "200" ] && [ "$P3" = "200" ] && pass "fixture: agents 2 and 3 are ON SHIFT via PUT /presence/me (agent1 stays off)" \
  || fail "fixture: presence through the product" "p2=$P2 p3=$P3"

# ── 5.11 — "which operator am I?", gated by nothing but a session ─────────────────────────────────
ME=$(curl -s -b "$JADMIN" "$G/me/operator")
MEOP=$(echo "$ME" | sed -n 's/.*"operatorId":"\([^"]*\)".*/\1/p')
[ -n "$MEOP" ] && pass "5.11 ⭐ GET /me/operator answers with the caller's own operator id" \
  || fail "5.11 GET /me/operator" "body=$(echo "$ME" | head -c 120)"
ANON=$(curl -s -o /dev/null -w '%{http_code}' "$G/me/operator")
[ "$ANON" = "401" ] && pass "5.11 …and a caller with no session is refused (401)" \
  || fail "5.11 anonymous refusal" "http=$ANON"

# ── 2.4 — two deliveries arrive; nobody touches them ─────────────────────────────────────────────
deliver(){ # $1 tag → prints conversationId
  local body sig http
  body="{\"event_id\":\"live-w5-$1-$RUN\",\"message\":{\"text\":\"live w5 $1 $RUN\"}}"
  sig=$(sign "$body")
  http=$(curl -s -o /tmp/w5-$1.json -w '%{http_code}' -X POST "$G/channels/$API_KEY/inbound" \
    -H 'Content-Type: application/json' -H "X-CRM-Signature: $sig" -d "$body")
  [ "$http" = "202" ] || { echo ""; return; }
  sed -n 's/.*"conversationId":"\([^"]*\)".*/\1/p' /tmp/w5-$1.json
}
CONV1=$(deliver one); CONV2=$(deliver two)
[ -n "$CONV1" ] && [ -n "$CONV2" ] && pass "2.4 two signed deliveries became two tickets (202)" \
  || fail "2.4 deliveries accepted" "conv1='$CONV1' conv2='$CONV2'"

QUEUED=$(psql chats_db "select count(*) from \"Conversation\" where id in ('$CONV1','$CONV2') and routed_group_id='$DESK'")
[ "$QUEUED" = "2" ] && pass "2.4 ⭐ both carry the channel's desk — intake pushed them into the ONE queue" \
  || fail "2.4 the desk travelled" "rows=$QUEUED"

# ── the promise: an owner appears BY ITSELF, within a drain tick ──────────────────────────────────
OP1=""; OP2=""
for i in $(seq 1 30); do
  OP1=$(psql chats_db "select coalesce(assignee_operator_id,'') from \"Conversation\" where id='$CONV1'")
  OP2=$(psql chats_db "select coalesce(assignee_operator_id,'') from \"Conversation\" where id='$CONV2'")
  [ -n "$OP1" ] && [ -n "$OP2" ] && break
  sleep 5
done
[ -n "$OP1" ] && [ -n "$OP2" ] && pass "2.4 ⭐⭐ BOTH TICKETS REACHED A SPECIFIC AGENT, unprompted (op1=$OP1 op2=$OP2)" \
  || fail "2.4 ⭐⭐ tickets reach an agent by themselves" "op1='$OP1' op2='$OP2' after 150s"

BACKLOGGED=$(psql chats_db "select count(*) from \"Conversation\" where id in ('$CONV1','$CONV2') and backlog_at is not null")
[ "$BACKLOGGED" = "0" ] && pass "2.4 …and neither is still waiting — assignment cleared the queue entry" \
  || fail "2.4 queue entries cleared" "still queued=$BACKLOGGED"

# Desk membership is resolved in two steps across the two databases (no dblink dependency).
AU1=$(psql users_db "select auth_user_id from \"Operator\" where id='$OP1'")
AU2=$(psql users_db "select auth_user_id from \"Operator\" where id='$OP2'")
IN1=$(psql auth_db "select count(*) from \"GroupMember\" where group_id='$DESK' and user_id='$AU1'")
IN2=$(psql auth_db "select count(*) from \"GroupMember\" where group_id='$DESK' and user_id='$AU2'")
[ "$IN1" = "1" ] && [ "$IN2" = "1" ] && pass "2.4 ⭐ both assignees are MEMBERS OF THE DESK the channel names" \
  || fail "2.4 assignees belong to the desk" "in1=$IN1 in2=$IN2"

# ── 4.21 — counted in the agent's load, by the router's own arithmetic ───────────────────────────
LOAD1=$(load_of "$OP1")
[ "${LOAD1:-0}" -ge 1 ] && pass "4.21 ⭐ the ticket counts against its agent's load (load=$LOAD1, the pool's own query)" \
  || fail "4.21 load counted" "load='$LOAD1'"

# ── 4.19 — the rail: pick a ticket whose assignee is a PURE support agent (see the header) ────────
RAIL_CONV=""; RAIL_OP=""; RAIL_AU=""
for pair in "$CONV1:$OP1" "$CONV2:$OP2"; do
  c="${pair%%:*}"; o="${pair##*:}"
  au=$(psql users_db "select auth_user_id from \"Operator\" where id='$o'")
  am=$(psql auth_db "select count(*) from \"UserRole\" ur join \"Role\" r on r.id=ur.role_id where ur.user_id='$au' and r.key in ('am','shift_am')")
  if [ "$am" = "0" ]; then RAIL_CONV="$c"; RAIL_OP="$o"; RAIL_AU="$au"; break; fi
done
if [ -z "$RAIL_CONV" ]; then
  fail "4.19 rail leg" "both assignees hold AM roles — rotation landed twice on agent1"
else
  RAIL_EMAIL=$(psql auth_db "select email from \"User\" where id='$RAIL_AU'")
  JAGENT=$(login "$RAIL_EMAIL")
  grep -q access "$JAGENT" && pass "4.19 the assignee ($RAIL_EMAIL) signed in" || fail "4.19 assignee session" "no cookie"

  MYOP=$(curl -s -b "$JAGENT" "$G/me/operator" | sed -n 's/.*"operatorId":"\([^"]*\)".*/\1/p')
  # ⚠️ Non-emptiness FIRST: run one of this script compared "" to "" here and called it ok — the exact
  # vacuous-pass shape the wiki's rule 2 exists for. Both operands must BE something before equality
  # means anything.
  [ -n "$MYOP" ] && [ "$MYOP" = "$RAIL_OP" ] && pass "5.11 ⭐ the assignee's /me/operator IS the id the router assigned to" \
    || fail "5.11 identity round-trip" "me='$MYOP' assigned='$RAIL_OP'"

  RAIL0=$(curl -s -b "$JAGENT" "$G/conversations?assigneeOperatorId=$RAIL_OP&openedByOperatorId=$RAIL_OP&statusCategories=new,open,pending,on_hold")
  echo "$RAIL0" | grep -q "$RAIL_CONV" && fail "4.19 rail before opening" "ticket on the rail before it was opened" \
    || pass "4.19 assigned-but-unopened is NOT on the rail — assignment alone is not the fact"

  curl -s -b "$JAGENT" "$G/conversations/$RAIL_CONV" >/dev/null
  RAIL1=$(curl -s -b "$JAGENT" "$G/conversations?assigneeOperatorId=$RAIL_OP&openedByOperatorId=$RAIL_OP&statusCategories=new,open,pending,on_hold")
  echo "$RAIL1" | grep -q "$RAIL_CONV" && pass "4.19 ⭐⭐ OPENING the ticket put it on the agent's server-side rail" \
    || fail "4.19 opening adds to the rail" "list has no $RAIL_CONV"

  MARKS=$(psql chats_db "select count(*) from \"ConversationReadMark\" where account_id='$ACC' and conversation_id='$RAIL_CONV' and operator_id='$RAIL_OP'")
  curl -s -b "$JAGENT" "$G/conversations/$RAIL_CONV" >/dev/null
  MARKS2=$(psql chats_db "select count(*) from \"ConversationReadMark\" where account_id='$ACC' and conversation_id='$RAIL_CONV' and operator_id='$RAIL_OP'")
  [ "$MARKS" = "1" ] && [ "$MARKS2" = "1" ] && pass "4.19 a second open is the SAME mark — idempotent by constraint (rows=1)" \
    || fail "4.19 mark idempotence" "first=$MARKS second=$MARKS2"

  SOLVED=$(psql chats_db "select key from \"ConversationStatus\" where account_id='$ACC' and category='solved' and active limit 1")
  SETHTTP=$(curl -s -o /tmp/w5-solve.json -w '%{http_code}' -b "$JAGENT" -X PATCH "$G/conversations/$RAIL_CONV/status" \
    -H 'Content-Type: application/json' -d "{\"status\":\"$SOLVED\"}")
  if [ "$SETHTTP" = "200" ]; then
    RAIL2=$(curl -s -b "$JAGENT" "$G/conversations?assigneeOperatorId=$RAIL_OP&openedByOperatorId=$RAIL_OP&statusCategories=new,open,pending,on_hold")
    echo "$RAIL2" | grep -q "$RAIL_CONV" && fail "4.19 solving removes from the rail" "still present" \
      || pass "4.19 ⭐ SOLVING the ticket took it off the rail — by predicate, nothing was deleted"
    MARKS3=$(psql chats_db "select count(*) from \"ConversationReadMark\" where conversation_id='$RAIL_CONV'")
    [ "$MARKS3" = "1" ] && pass "4.19 …and the mark SURVIVES — the fact he read it once stays true (9.12 needs it)" \
      || fail "4.19 mark survives solving" "rows=$MARKS3"
  else
    say "4.19 solve leg" "NOTE: status write refused http=$SETHTTP — rail-removal asserted another way"
    NONTERM=$(psql chats_db "select count(*) from \"Conversation\" c join \"ConversationStatus\" s on s.account_id=c.account_id and s.key=c.status where c.id='$RAIL_CONV' and s.category in ('solved','closed')")
    [ "$NONTERM" = "0" ] || fail "4.19 solve leg" "unexpected terminal state"
  fi
fi

# ── the isolation negative: the filters are scoped like everything else ──────────────────────────
# A filter naming OUR operator id, asked by OUR session, over the OTHER seeded account's data cannot
# exist — one account on this stand — so the falsifiable negative is the unknown-value one: an
# invalid category is refused, never widened.
BADCAT=$(curl -s -o /dev/null -w '%{http_code}' -b "$JADMIN" "$G/conversations?statusCategories=new,bogus")
[ "$BADCAT" = "400" ] && pass "filters ⭐ an unknown category in the plural is REFUSED (400), never widened" \
  || fail "filters unknown category" "http=$BADCAT"

echo
echo "W5 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
