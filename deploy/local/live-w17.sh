#!/usr/bin/env bash
# MVP block W17 — live round (subpoints 4.4 + 4.5 + 4.6): the VIP tab's wire.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The operator's Done-when, asserted live: «вхожу как AM → вижу только своих игроков и только их
# тикеты → чужой тикет не открывается даже по прямой ссылке → могу написать своему игроку первым».
#
#   ⭐ the portfolio is REAL (self-assign through the product, then /me/players carries the pair);
#   ⛔ a ticket outside the portfolio answers NOT FOUND to a DIRECT LINK;
#   ⭐ write first WORKS end to end: initiate → the message is in the thread → the outbox row is
#     GONE (deleted-on-success) with no dead letter — the mail left the building;
#   ⛔ and the three refusals that make it safe: a player not yours (403), a role without the
#     module key (403 — the reply key alone must NOT be enough), a player with no known address (400).
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Assignments are reset at the start (DELETE → POST is
# deterministic); each run leaves ONE new outbound conversation — synthetic data doing its job.
# ⚠️ If no player has an email participant yet (nobody has written in), the round SEEDS one fixture
# participant row and says so — the same honesty as W9's self-seeded lookup fixture.
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
note(){ say "NOTE: $1" "-"; }
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

JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JOWNER" && pass "owner session" \
  || { fail "owner session" "no cookie"; echo "W17 live: $ok ok, $bad failed"; exit 1; }
JAM=$(login "role-am@beton.win" "$ROLE_PW")
grep -q access "$JAM" && pass "AM session (the block's protagonist)" || fail "AM session" "no cookie"
JAGENT=$(login "role-support-agent@beton.win" "$ROLE_PW")
grep -q access "$JAGENT" && pass "line-agent session (the gate's negative control)" || fail "agent session" "no cookie"

# ── 0. fixtures: a player WITH a known address, and one WITHOUT ────────────────────────────────────
PAIR=$(psql users_db "select brand_id || '|' || player_id from \"ChannelParticipant\" where account_id='$ACC' and kind='email' and player_id is not null limit 1")
if [ -z "$PAIR" ]; then
  ANYP=$(psql users_db "select brand_id || '|' || player_id from \"Player\" where account_id='$ACC' limit 1")
  BR=${ANYP%%|*}; PL=${ANYP##*|}
  psql users_db "insert into \"ChannelParticipant\" (id, account_id, brand_id, kind, address, player_id) values (gen_random_uuid()::text, '$ACC', '$BR', 'email', 'w17-first@stand.test', '$PL') on conflict do nothing" >/dev/null
  PAIR="$BR|$PL"
  note "no player had ever written in — seeded ONE fixture participant (w17-first@stand.test), as W9 did"
fi
BRAND=${PAIR%%|*}; PLAYER=${PAIR##*|}
pass "a player with a known address to write to ($PLAYER @ $BRAND)"

NOADDR=$(psql users_db "select player_id from \"Player\" p where p.account_id='$ACC' and p.brand_id='$BRAND' and p.player_id <> '$PLAYER' and not exists (select 1 from \"ChannelParticipant\" c where c.account_id='$ACC' and c.brand_id=p.brand_id and c.player_id=p.player_id and c.kind='email') limit 1")
[ -n "$NOADDR" ] && pass "…and one with NO known address ($NOADDR) for the labelled refusal" \
  || note "every player has an address — the no-address refusal has nothing to check this run"

# ── 1. the portfolio: built through the product BY THE OWNER, read back by the AM ─────────────────
# ⚠️ Deliberately NOT a self-assign. The first draft had the AM attach the player themselves and
# feature 026's own spec refused the key grant that needed: `users.player.assign` is a self-granted
# route into the `am_only` tier, off for every operational role until granted PER PERSON. Building a
# portfolio is an administrator's act; the tab needs the portfolio to EXIST, not to be self-built.
AMID=$(psql auth_db "select id from \"User\" where email='role-am@beton.win'")
[ -n "$AMID" ] && pass "the AM's user id resolved for the owner's assignment" || fail "AM user id" "not found"
curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/players/$BRAND/$PLAYER/assignment"
ASSIGN=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X POST "$G/players/$BRAND/$PLAYER/assignment" \
  -H 'Content-Type: application/json' -d "{\"amAuthUserId\":\"$AMID\"}")
case "$ASSIGN" in 200|201|204) pass "the owner attaches the player TO the AM (an administrator's act)" ;;
  *) fail "owner assigns to AM" "http $ASSIGN" ;; esac
MINE=$(curl -s -b "$JAM" "$G/me/players")
case "$MINE" in
  *"$PLAYER"*) pass "⭐ GET /me/players carries the pair — the tab's portfolio read is real" ;;
  *) fail "portfolio read" "${MINE:0:140}" ;;
esac

# ── 2. ⛔ a ticket OUTSIDE the portfolio does not open by direct link ──────────────────────────────
OTHER=$(curl -s -b "$JOWNER" "$G/conversations?pageSize=10" | tr '{' '\n' | grep '"id"' | grep -v "\"playerId\":\"$PLAYER\"" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
if [ -n "$OTHER" ]; then
  DIRECT=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAM" "$G/conversations/$OTHER")
  case "$DIRECT" in
    403|404) pass "⛔ someone else's ticket by DIRECT LINK answers $DIRECT to the AM — the Done-when's sharp edge" ;;
    *) fail "foreign ticket by direct link" "http $DIRECT — the AM read a ticket outside their portfolio" ;;
  esac
else
  note "no foreign conversation found to probe the direct link with"
fi

# ── 3. ⭐ write first — end to end ─────────────────────────────────────────────────────────────────
STAMP=$RANDOM
INIT=$(curl -s -o /tmp/w17.init -w '%{http_code}' -b "$JAM" -X POST "$G/conversations/initiate-email" \
  -H 'Content-Type: application/json' \
  -d "{\"brandId\":\"$BRAND\",\"playerId\":\"$PLAYER\",\"subject\":\"W17 probe $STAMP\",\"body\":\"A first word from your manager ($STAMP).\"}")
CID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/w17.init | head -1)
if [ "$INIT" = "201" ] || [ "$INIT" = "200" ]; then
  if [ -n "$CID" ] && grep -q '"channel":"email"' /tmp/w17.init; then
    pass "⭐ the AM wrote FIRST — conversation $CID exists on the email channel"
  else
    fail "initiate response shape" "$(head -c 140 /tmp/w17.init)"
  fi
else
  fail "initiate" "http $INIT — $(head -c 140 /tmp/w17.init)"
fi
THREAD=$(curl -s -b "$JAM" "$G/conversations/$CID/thread")
case "$THREAD" in
  *"($STAMP)"*) pass "…the first message is IN the thread, readable by its author" ;;
  *) fail "message in thread" "${THREAD:0:120}" ;;
esac
# ⚠️ Guarded against the vacuous pass this script shipped with: an empty CID makes the count 0 for
# free, and "the outbox is empty for a conversation that does not exist" proves nothing (rule 3).
if [ -z "$CID" ]; then
  fail "outbound delivered" "no conversation id — nothing to check the outbox for"
else
  # The outbox drains on ITS OWN tick; first confirm the intent EXISTED (the positive control),
  # then that it left. A row that never existed and a row delivered look identical afterwards.
  SENT=""
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    LEFT=$(psql chats_db "select count(*) from \"OutboundMessage\" where account_id='$ACC' and conversation_id='$CID'")
    [ "$LEFT" = "0" ] && { SENT=yes; break; }
    sleep 5
  done
  EXTID=$(psql chats_db "select count(*) from \"Message\" where conversation_id='$CID' and external_id is not null")
  if [ "$SENT" = "yes" ] && [ "${EXTID:-0}" = "1" ]; then
    pass "⭐ …the outbox row is GONE and the message carries its Message-ID — the mail actually left"
  elif [ "$SENT" = "yes" ]; then
    fail "outbound delivered" "outbox empty but no Message-ID was ever written — the intent may never have existed"
  else
    STATE=$(psql chats_db "select status || '/' || attempts from \"OutboundMessage\" where conversation_id='$CID' limit 1")
    fail "outbound delivered" "row still present after 60s ($STATE)"
  fi
fi

# ── 4. ⛔ the refusals that make it safe ───────────────────────────────────────────────────────────
# The pair from ANY brand — the portfolio check is pair-based and fires before every other
# precondition, so a foreign player refuses 403 whatever their brand's channel situation is.
FPAIR=$(psql users_db "select brand_id || '|' || player_id from \"Player\" where account_id='$ACC' and not (brand_id='$BRAND' and player_id in ('$PLAYER','${NOADDR:-none}')) limit 1")
if [ -n "$FPAIR" ]; then
  FBRAND=${FPAIR%%|*}; FOREIGN=${FPAIR##*|}
  curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/players/$FBRAND/$FOREIGN/assignment"
  NOTMINE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAM" -X POST "$G/conversations/initiate-email" \
    -H 'Content-Type: application/json' -d "{\"brandId\":\"$FBRAND\",\"playerId\":\"$FOREIGN\",\"body\":\"x\"}")
  [ "$NOTMINE" = "403" ] && pass "⛔ a player NOT attached to the AM is refused (403) — the portfolio rule on the WRITE" \
    || fail "portfolio rule on write" "http $NOTMINE"
else
  # A visible NOTE where the assertion would have been — a silent skip reads as a pass (rule 3).
  note "no foreign player exists to probe the portfolio rule with"
fi
AGENTGATE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAGENT" -X POST "$G/conversations/initiate-email" \
  -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND\",\"playerId\":\"$PLAYER\",\"body\":\"x\"}")
[ "$AGENTGATE" = "403" ] && pass "⛔ a line agent is refused (403) — the reply key alone must not initiate" \
  || fail "module key gates initiate" "http $AGENTGATE"
if [ -n "$NOADDR" ]; then
  curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/players/$BRAND/$NOADDR/assignment"
  curl -s -o /dev/null -b "$JOWNER" -X POST "$G/players/$BRAND/$NOADDR/assignment" \
    -H 'Content-Type: application/json' -d "{\"amAuthUserId\":\"$AMID\"}"
  NOADDRQ=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAM" -X POST "$G/conversations/initiate-email" \
    -H 'Content-Type: application/json' -d "{\"brandId\":\"$BRAND\",\"playerId\":\"$NOADDR\",\"body\":\"x\"}")
  [ "$NOADDRQ" = "400" ] && pass "⛔ an attached player with NO known address is a labelled 400, never a guess" \
    || fail "no-address refusal" "http $NOADDRQ"
  curl -s -o /dev/null -b "$JOWNER" -X DELETE "$G/players/$BRAND/$NOADDR/assignment"
fi

echo
echo "W17 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
