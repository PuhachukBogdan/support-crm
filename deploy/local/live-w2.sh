#!/usr/bin/env bash
# MVP block W2 — live round (roadmap 4.16, ADR 0040). What only a real database can answer:
#   2.3a  the migration ran and left NO conversation on a status the catalogue cannot resolve
#   2.3b  the nine statuses are there, with both names, in categories
#   2.3c  an agent cannot change a brand; a supervisor can, and it is audited
# Plus the two things a unit test cannot see: the composite FK actually refuses, and the
# category filter narrows real rows.
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
SEED_PW='Stand#Seed7x'
OWNER=mistydubteck@beton.win
OWNER_PW='m13aP1LLB07vyh#7A'
AGENT=seed-agent1@example.test
ACC=seed-account-0000-0000-000000000001
CONV_BRAND2=seed-conv-brand2-0000-000000001
BRAND_1=seed-brand-0000-0000-000000000001
BRAND_2=seed-brand-0000-0000-000000000002
ok=0; bad=0
say(){ printf "%-64s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r '; }

login(){ # $1 email $2 password → prints a cookie-jar path
  local ch jar code
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  echo "$jar"
}

JO=$(login "$OWNER" "$OWNER_PW"); grep -q access "$JO" && pass "owner session" || fail "owner session" "no cookie"
JA=$(login "$AGENT" "$SEED_PW");  grep -q access "$JA" && pass "agent session" || fail "agent session" "no cookie"

# ── 2.3a / 2.3b — the catalogue exists and the migration mapped every row ────────────────────────
N=$(psql chats_db "select count(*) from \"ConversationStatus\" where account_id='$ACC'")
[ "$N" = "9" ] && pass "2.3b nine statuses configured for the seed account" \
  || fail "2.3b nine statuses configured for the seed account" "rows=$N"

UNMAPPED=$(psql chats_db "select count(*) from \"Conversation\" c left join \"ConversationStatus\" s on s.account_id=c.account_id and s.key=c.status where s.key is null")
[ "$UNMAPPED" = "0" ] && pass "2.3a ⭐ NO conversation is on an unresolvable status" \
  || fail "2.3a ⭐ NO conversation is on an unresolvable status" "rows=$UNMAPPED"

OLD=$(psql chats_db "select count(*) from \"Conversation\" where status in ('resolved','snoozed')")
[ "$OLD" = "0" ] && pass "2.3a the retired words are gone from the data" \
  || fail "2.3a the retired words are gone from the data" "rows=$OLD"

STORED=$(psql chats_db "select count(*) from \"Macro\" where definition::text like '%CONVERSATION_STATUS_%'")
STORED2=$(psql chats_db "select count(*) from \"Automation\" where definition::text like '%CONVERSATION_STATUS_%'")
[ "$STORED" = "0" ] && [ "$STORED2" = "0" ] && pass "2.3a no stored rule still names a proto enum" \
  || fail "2.3a no stored rule still names a proto enum" "macros=$STORED automations=$STORED2"

# ⭐ The constraint itself. A unit test cannot see this: the guarantee is the DATABASE's.
FKREFUSED=$(docker compose exec -T postgres psql -U postgres -d chats_db -c \
  "update \"Conversation\" set status='waiting_on_finance' where id='$CONV_BRAND2'" 2>&1 | grep -c "violates foreign key" || true)
[ "$FKREFUSED" = "1" ] && pass "2.3a ⭐ the FK REFUSES a status nobody configured" \
  || fail "2.3a ⭐ the FK REFUSES a status nobody configured" "no violation reported"

# ── the catalogue over the REST edge, with both names ────────────────────────────────────────────
CAT=$(curl -s -b "$JO" "$G/conversations/statuses")
echo "$CAT" | grep -q '"statusKey"\|"key"' && pass "2.3a the catalogue is readable over REST" \
  || fail "2.3a the catalogue is readable over REST" "$(echo "$CAT" | head -c 120)"
echo "$CAT" | grep -q 'Supervisor Review' && pass "2.3b a status the flat enum could not express is present" \
  || fail "2.3b a status the flat enum could not express is present" "$(echo "$CAT" | head -c 120)"
echo "$CAT" | grep -q 'Awaiting your reply' && pass "2.3b ⭐ DUAL NAMING: agent name and end-user name differ" \
  || fail "2.3b ⭐ DUAL NAMING: agent name and end-user name differ" "no end-user name in the payload"
echo "$CAT" | grep -q 'CONVERSATION_STATUS_CATEGORY_ON_HOLD' && pass "2.3a statuses resolve to CATEGORIES" \
  || fail "2.3a statuses resolve to CATEGORIES" "no category on the wire"

# ── the list: the row carries the key + category, and a category filter narrows ──────────────────
ONE=$(curl -s -b "$JO" "$G/conversations/$CONV_BRAND2")
echo "$ONE" | grep -q '"statusKey":"in_progress"' && pass "2.3a the detail carries the status KEY" \
  || fail "2.3a the detail carries the status KEY" "$(echo "$ONE" | head -c 160)"
echo "$ONE" | grep -q 'CONVERSATION_STATUS_CATEGORY_ON_HOLD' && pass "2.3a the detail carries the CATEGORY" \
  || fail "2.3a the detail carries the CATEGORY" "$(echo "$ONE" | head -c 160)"

SOLVED_DB=$(psql chats_db "select count(*) from \"Conversation\" c join \"ConversationStatus\" s on s.account_id=c.account_id and s.key=c.status where c.account_id='$ACC' and s.category='solved'")
SOLVED_API=$(curl -s -b "$JO" "$G/conversations?statusCategory=solved&pageSize=100" | grep -o '"id"' | wc -l | tr -d ' ')
[ "$SOLVED_DB" = "$SOLVED_API" ] && [ "$SOLVED_DB" != "0" ] \
  && pass "2.3a ⭐ the category filter returns exactly the rows the database has ($SOLVED_DB)" \
  || fail "2.3a ⭐ the category filter returns exactly the rows the database has" "db=$SOLVED_DB api=$SOLVED_API"

KEYED=$(curl -s -b "$JO" "$G/conversations?status=vip_pending&pageSize=100" | grep -o '"statusKey":"[a-z_]*"' | sort -u)
[ "$KEYED" = '"statusKey":"vip_pending"' ] && pass "2.3a an exact key filter returns only that status" \
  || fail "2.3a an exact key filter returns only that status" "got=$KEYED"

BADKEY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JO" "$G/conversations?status=nonsense")
[ "$BADKEY" = "400" ] && pass "2.3a an unknown key is refused, not silently widened" \
  || fail "2.3a an unknown key is refused, not silently widened" "http=$BADKEY"
BADCAT=$(curl -s -o /dev/null -w '%{http_code}' -b "$JO" "$G/conversations?statusCategory=snoozed")
[ "$BADCAT" = "400" ] && pass "2.3a an unknown CATEGORY is refused at the edge" \
  || fail "2.3a an unknown CATEGORY is refused at the edge" "http=$BADCAT"

# ── a status the old vocabulary could not express, written through the product ───────────────────
SET=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/conversations/$CONV_BRAND2/status" \
  -H 'Content-Type: application/json' -d '{"status":"supervisor_review"}')
NOW=$(psql chats_db "select status from \"Conversation\" where id='$CONV_BRAND2'")
[ "$SET" = "200" ] && [ "$NOW" = "supervisor_review" ] \
  && pass "2.3a ⭐ an agent SETS a status the flat enum had no room for" \
  || fail "2.3a ⭐ an agent SETS a status the flat enum had no room for" "http=$SET status=$NOW"

BADSET=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/conversations/$CONV_BRAND2/status" \
  -H 'Content-Type: application/json' -d '{"status":"closed"}')
[ "$BADSET" = "400" ] && pass "2.3a a CATEGORY is not settable as a status" \
  || fail "2.3a a CATEGORY is not settable as a status" "http=$BADSET"

# ── 2.3c — the brand write rule ──────────────────────────────────────────────────────────────────
BEFORE_AUDIT=$(psql chats_db "select count(*) from \"AuditEntry\" where action='conversation.brand_changed'")

AGENT_TRY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/conversations/$CONV_BRAND2/brand" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND_1\"}")
BRAND_AFTER_AGENT=$(psql chats_db "select brand_id from \"Conversation\" where id='$CONV_BRAND2'")
if [ "$AGENT_TRY" = "403" ] && [ "$BRAND_AFTER_AGENT" = "$BRAND_2" ]; then
  pass "2.3c ⭐ AN AGENT CANNOT CHANGE THE BRAND (403, and the row is untouched)"
else
  fail "2.3c ⭐ AN AGENT CANNOT CHANGE THE BRAND" "http=$AGENT_TRY brand=$BRAND_AFTER_AGENT"
fi

SUP_TRY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JO" -X PATCH "$G/conversations/$CONV_BRAND2/brand" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND_1\"}")
BRAND_AFTER_SUP=$(psql chats_db "select brand_id from \"Conversation\" where id='$CONV_BRAND2'")
if [ "$SUP_TRY" = "200" ] && [ "$BRAND_AFTER_SUP" = "$BRAND_1" ]; then
  pass "2.3c ⭐ POSITIVE CONTROL: a supervisor's change succeeds"
else
  fail "2.3c ⭐ POSITIVE CONTROL: a supervisor's change succeeds" "http=$SUP_TRY brand=$BRAND_AFTER_SUP"
fi

AFTER_AUDIT=$(psql chats_db "select count(*) from \"AuditEntry\" where action='conversation.brand_changed'")
[ "$AFTER_AUDIT" = "$((BEFORE_AUDIT + 1))" ] && pass "2.3c exactly ONE audit entry was written" \
  || fail "2.3c exactly ONE audit entry was written" "before=$BEFORE_AUDIT after=$AFTER_AUDIT"

DETAIL=$(psql chats_db "select detail_json::text from \"AuditEntry\" where action='conversation.brand_changed' order by created_at desc limit 1")
echo "$DETAIL" | grep -q "$BRAND_2" && echo "$DETAIL" | grep -q "$BRAND_1" \
  && pass "2.3c the entry records BOTH brands, as refs" \
  || fail "2.3c the entry records BOTH brands, as refs" "detail=$DETAIL"

NOOP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JO" -X PATCH "$G/conversations/$CONV_BRAND2/brand" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND_1\"}")
AFTER_NOOP=$(psql chats_db "select count(*) from \"AuditEntry\" where action='conversation.brand_changed'")
[ "$NOOP" = "400" ] && [ "$AFTER_NOOP" = "$AFTER_AUDIT" ] \
  && pass "2.3c a no-op change is refused and files no entry" \
  || fail "2.3c a no-op change is refused and files no entry" "http=$NOOP entries=$AFTER_NOOP"

# ── restore the fixture, through the product, so a re-run starts where this one did ──────────────
curl -s -o /dev/null -b "$JO" -X PATCH "$G/conversations/$CONV_BRAND2/brand" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND_2\"}"
curl -s -o /dev/null -b "$JA" -X PATCH "$G/conversations/$CONV_BRAND2/status" \
  -H 'Content-Type: application/json' -d '{"status":"in_progress"}'
RESTORED=$(psql chats_db "select brand_id||'/'||status from \"Conversation\" where id='$CONV_BRAND2'")
[ "$RESTORED" = "$BRAND_2/in_progress" ] && pass "the fixture is restored through the product's own path" \
  || fail "the fixture is restored through the product's own path" "state=$RESTORED"

# ── nothing leaked ──────────────────────────────────────────────────────────────────────────────
LEAK=$(docker compose logs --no-log-prefix --since 10m chats gateway 2>/dev/null \
  | grep -cE "$SEED_PW|$OWNER_PW" || true)
[ "$LEAK" = "0" ] && pass "no password appears in any service log" \
  || fail "no password appears in any service log" "hits=$LEAK"

echo
echo "W2 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
