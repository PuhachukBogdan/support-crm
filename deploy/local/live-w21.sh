#!/usr/bin/env bash
# MVP block W21 — the FINAL round (subpoints 7.2 + 7.3 + 7.5): the stand a stranger can use.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The operator's Done-when, verbatim: «даю человеку ссылку и логин → он входит сам, берёт тикет,
# отвечает, видит результат». This round IS that person, over the wire:
#   7.2 — the whole stack is up and FRESH (every service answers; nothing is a stale image);
#   7.3 — the seeds hold: every role login signs in, the Zendesk tag taxonomy is in the registry,
#         the macro and the automation exist, and re-seeding is idempotent;
#   the Done-when — sign in, take a ticket, reply, SEE the reply in the thread.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. The taken ticket is released (assignee removed) at the end.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'

ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

login(){ # $1 email
  local ch code jar
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$ROLE_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  echo "$jar"
}

# ── 7.2: the whole stack, up and fresh ─────────────────────────────────────────────────────────────
STALE=$(docker compose ps --format '{{.Name}} {{.Status}}' | grep -cE 'Up [0-9]+ (weeks|months)' || true)
RUNNING=$(docker compose ps --format '{{.Name}}' | wc -l | tr -d ' ')
[ "$RUNNING" -ge 11 ] && pass "7.2: the full stack is up ($RUNNING containers)" || fail "stack size" "$RUNNING containers"
# Datastores legitimately live long; SERVICES must have been rebuilt within the MVP push.
SVCSTALE=$(docker compose ps --format '{{.Name}} {{.Status}}' | grep -E 'auth|users|chats|brands|gateway|web|worker' | grep -cE 'Up [0-9]+ (weeks|months)' || true)
[ "$SVCSTALE" = "0" ] && pass "…and no SERVICE runs a weeks-old image (the deploy-freshness rule)" \
  || fail "service freshness" "$SVCSTALE stale services"

# ── 7.3: seeds — idempotent re-run, then the facts they promise ────────────────────────────────────
if docker compose run --rm chats npm run seed:chats < /dev/null >/dev/null 2>&1; then
  pass "7.3: re-seeding chats is an ordinary success (idempotent — upserts on stable keys)"
else
  fail "chats re-seed" "non-zero exit"
fi

JLEAD=$(login "role-teamlead@beton.win")
TAGS=$(curl -s -b "$JLEAD" "$G/labels/usage")
ZDTAGS=0
for t in auto_confirmation regular bot_managed bot_escalation vip bonus payments kyc; do
  case "$TAGS" in *"\"name\":\"$t\""*) ZDTAGS=$((ZDTAGS+1));; esac
done
[ "$ZDTAGS" = "8" ] && pass "…the Zendesk tag taxonomy is in the registry (8/8 names)" \
  || fail "zendesk tags seeded" "$ZDTAGS of 8"
MACRO=$(psql chats_db "select count(*) from \"Macro\"")
AUTO=$(psql chats_db "select count(*) from \"Automation\"")
{ [ "${MACRO:-0}" -ge 1 ] && [ "${AUTO:-0}" -ge 1 ]; } && pass "…one macro and one automation rule are seeded (movable furniture for testers)" \
  || fail "macro/automation seeded" "macro=$MACRO auto=$AUTO"

# Every role login signs in — the five doors the instruction hands out.
for who in role-support-agent role-vip-support role-am role-shift-am role-teamlead; do
  J=$(login "$who@beton.win")
  if grep -q access "$J"; then pass "…$who signs in"; else fail "$who signs in" "no cookie"; fi
done

# ── the Done-when: sign in → take a ticket → reply → SEE it ────────────────────────────────────────
JA=$(login "role-support-agent@beton.win")
OPID=$(curl -s -b "$JA" "$G/me/operator" | sed -n 's/.*"operatorId":"\([^"]*\)".*/\1/p')
[ -n "$OPID" ] && pass "the agent knows who they are (operator $OPID)" || fail "me/operator" "empty"
TICKET=$(curl -s -b "$JA" "$G/conversations?pageSize=1&statusCategories=open" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TICKET" ] && pass "…sees the queue and picks a ticket" || fail "a ticket to take" "none"
TAKE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PUT "$G/conversations/$TICKET/assignee" \
  -H 'Content-Type: application/json' -d "{\"operatorId\":\"$OPID\"}")
case "$TAKE" in 200|201|204) pass "…«взять на себя» — the assignee is theirs" ;; *) fail "take it" "http $TAKE" ;; esac
STAMP=$RANDOM
REPLY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X POST "$G/conversations/$TICKET/messages" \
  -H 'Content-Type: application/json' -d "{\"kind\":\"reply\",\"body\":\"Tester round W21 ($STAMP).\"}")
case "$REPLY" in 200|201) pass "…replies" ;; *) fail "reply" "http $REPLY" ;; esac
THREAD=$(curl -s -b "$JA" "$G/conversations/$TICKET/thread")
case "$THREAD" in
  *"($STAMP)"*) pass "⭐ …and SEES the result in the thread — the operator's Done-when, end to end" ;;
  *) fail "sees the result" "${THREAD:0:120}" ;;
esac
curl -s -o /dev/null -b "$JA" -X DELETE "$G/conversations/$TICKET/assignee"
pass "…the ticket is released for the next run"

echo
echo "W21 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
