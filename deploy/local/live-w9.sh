#!/usr/bin/env bash
# MVP block W9 — live round (spec 035: subpoints 2.1f + 2.1g, roadmap 6.7, ADR 0044 §4/§5).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The block's criterion, verbatim from the plan:
#   «в неопознанном тикете ищу по телефону и прикрепляю к игроку»
#
# What only a live round can answer — every claim here is about the SERVER, not the screen:
#
#   an agent WITHOUT the key is refused (403) and the response carries nothing else
#   the same agent, GRANTED the key per person (3.6 override), finds a seeded contact and attaches
#   ⭐ the audit trail holds the HASH and never the value — grepped, not assumed
#   the rate cap refuses the 21st lookup in the window, AND that refusal is audited
#   detach warns first (the preview) and the counts match what the detach then reports
#   ⛔ no route lists players by contact outside a conversation (the absence is the feature)
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Every value is unique per run; the grant is left in place
# (it is a per-person override on a stand account, and re-granting is idempotent).
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
SEED_PW='Stand#Seed7x'
ACC=seed-account-0000-0000-000000000001

RUN=$(date +%s)
ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

login(){ # $1 email, $2 password (defaults to the seed password)
  local ch code jar pw
  pw="${2:-$SEED_PW}"
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$pw\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  echo "$jar"
}

# ── preflight: the fixtures this run stands on (a fixture is not what the script believes) ────────
#
# ⭐⭐ FOUND BY THIS ROUND, and it is a product finding rather than a script problem:
# **`ContactMatch` has NO WRITER anywhere in the product.** Three call sites READ the hash index
# (identity resolution at intake, the person service, and now W9's lookup) and nothing has ever
# written a row — feature 020 built the projection for a producer that was never built. Live, the
# lookup would therefore answer "none" for every real customer. Recorded in the plan; the design
# question (who learns that an address belongs to a player — a GR8 sync, or the manual attach
# teaching the automatic resolution) is the operator's, not this script's.
#
# ⇒ So this round SEEDS its own haystack, and says so. The hash is computed with the service's own
# formula (`sha256(salt:kind:normalised)`, `contact-match.ts`) using the stand's own salt — if the
# formula or the salt ever diverge, the lookup answers "none" and this round fails, which is the
# correct signal rather than a green run against a hand-made row.
if [ -f .env ]; then set -a; . ./.env >/dev/null 2>&1; set +a; fi
SALT="${CONTACT_HASH_SALT:-}"
[ -n "$SALT" ] || { fail "preflight: CONTACT_HASH_SALT" "absent from .env — cannot build the fixture"; echo "W9 live: $ok ok, $bad failed"; exit 1; }

SEED_PLAYER=$(psql users_db "select player_id from \"Player\" where account_id='$ACC' limit 1")
SEED_BRAND=$(psql users_db "select brand_id from \"Player\" where account_id='$ACC' limit 1")
[ -n "$SEED_PLAYER" ] || { fail "preflight: a seeded player" "users_db has none"; echo "W9 live: $ok ok, $bad failed"; exit 1; }
SEED_EMAIL="w9-live-$RUN@example.test"
HASH=$(printf '%s:%s:%s' "$SALT" email "$SEED_EMAIL" | openssl dgst -sha256 -hex | sed 's/.*= //')
psql users_db "insert into \"ContactMatch\" (account_id, brand_id, player_id, kind, value_hash) values ('$ACC','$SEED_BRAND','$SEED_PLAYER','email','$HASH') on conflict (account_id, brand_id, player_id, kind) do update set value_hash='$HASH'" >/dev/null
CM=$(psql users_db "select count(*) from \"ContactMatch\" where account_id='$ACC' and value_hash='$HASH'")
[ "${CM:-0}" -ge 1 ] && pass "preflight: a hashed contact exists to find (FIXTURE — the product writes none)" \
  || fail "preflight: contact match fixture" "insert produced no row"

# An UNIDENTIFIED conversation to search from — the only context the lookup exists in.
CONV=$(psql chats_db "select id from \"Conversation\" where account_id='$ACC' and identity_state='unidentified' limit 1")
if [ -z "$CONV" ]; then
  CONV="w9-live-$RUN"
  psql chats_db "insert into \"Conversation\" (id, account_id, brand_id, status, priority, channel, identity_state, created_at, updated_at) values ('$CONV','$ACC','$SEED_BRAND','new','normal','email','unidentified', now(), now())" >/dev/null
  pass "preflight: created an unidentified conversation for this run"
else
  pass "preflight: an unidentified conversation exists ($CONV)"
fi

# ⚠️⚠️ **THE CHECK MUST SURVIVE ITS OWN HISTORY** — third instance in one day, and the sharpest:
# this round deliberately EXHAUSTS a per-person hourly cap, so running it twice in a row (which the
# rule requires) would find the same agent still capped and fail every leg after the grant. The
# probe is therefore whichever seeded agent still has headroom in the window; the trail itself is
# the source of that answer, the same table the cap counts.
# Candidates: the seeded agents AND the role logins (`seed-role-logins.sh`), each with its own
# password — enough distinct people that a pair of consecutive runs never reuses one.
AGENT_EMAIL=""; AGENT_PW=""
for cand in "seed-agent2@example.test:$SEED_PW" "seed-agent3@example.test:$SEED_PW" \
            "role-support-agent@beton.win:Stand#Role7x" "role-vip-support@beton.win:Stand#Role7x" \
            "role-teamlead@beton.win:Stand#Role7x" "role-shift-am@beton.win:Stand#Role7x"; do
  EM=${cand%%:*}; PW=${cand#*:}
  UID_=$(psql auth_db "select id from \"User\" where email='$EM'")
  [ -n "$UID_" ] || continue
  USED=$(psql users_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and actor_user_id='$UID_' and action='contact.lookup' and created_at > now() - interval '1 hour'")
  if [ "${USED:-0}" -lt 5 ]; then AGENT_EMAIL="$EM"; AGENT_PW="$PW"; AGENT_ID="$UID_"; break; fi
done
[ -n "$AGENT_EMAIL" ] || { fail "preflight: an agent with cap headroom" "every candidate is inside the hour window — wait it out"; echo "W9 live: $ok ok, $bad failed"; exit 1; }
pass "preflight: probing as $AGENT_EMAIL (cap headroom checked on the trail itself)"

JAG=$(login "$AGENT_EMAIL" "$AGENT_PW")
grep -q access "$JAG" && pass "agent session" || { fail "agent session" "no cookie"; echo "W9 live: $ok ok, $bad failed"; exit 1; }
# ⚠️ The granter must be a SUPER-ADMIN: `platform.role.manage` is a super-admin exclusive (FR-018),
# so `admin@example.test` correctly answers 403 — found on run two, and it is the product being
# right. The stand's owner account is the one that may hand out a key.
OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}"
OWNER_PW="${OWNER_PW:-m13aP1LLB07vyh#7A}"
JADMIN=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JADMIN" && pass "owner session (the granter — only a super-admin may hand out a key)" \
  || { fail "owner session" "no cookie for $OWNER_EMAIL"; echo "W9 live: $ok ok, $bad failed"; exit 1; }

lookup(){ # $1 jar, $2 kind, $3 value → prints "HTTPCODE BODY"
  curl -s -o /tmp/w9.body -w '%{http_code}' -b "$1" -X POST "$G/conversations/$CONV/contact-lookup" \
    -H 'Content-Type: application/json' -d "{\"kind\":\"$2\",\"value\":\"$3\"}"
  printf ' '; cat /tmp/w9.body
}

# ── 1. WITHOUT the key: refused, and the body says nothing else ───────────────────────────────────
R=$(lookup "$JAG" email "$SEED_EMAIL")
CODE=${R%% *}; BODY=${R#* }
if [ "$CODE" = "403" ]; then
  pass "⛔ the lookup is refused without crm.contact.lookup (403)"
else
  fail "refusal without the key" "http $CODE"
fi
case "$BODY" in
  *"$SEED_EMAIL"*) fail "the refusal echoes the searched value" "value present in body" ;;
  *) pass "…and the refusal echoes neither the value nor a player" ;;
esac
# ⚠️ The first run FAILED this and the failure was the SCRIPT's: it searched the value it was about
# to build, so `$SEED_EMAIL` was empty and the pattern matched the body's every character. Both the
# fixture and the guard above now come first.

# ── 2. GRANT the key to this one person (3.6 override) ────────────────────────────────────────────
[ -n "$AGENT_ID" ] || fail "preflight: the agent's user id" "not found in auth_db"
GRANT=$(curl -s -o /dev/null -w '%{http_code}' -b "$JADMIN" -X PUT "$G/admin/access/users/$AGENT_ID/permissions" \
  -H 'Content-Type: application/json' -d '{"permissionKey":"crm.contact.lookup","grant":true}')
case "$GRANT" in
  200|201|204) pass "the key is granted to ONE person, by an admin (http $GRANT)" ;;
  *) fail "grant the key" "http $GRANT" ;;
esac
sleep 31  # the gateway caches effective permissions for 30s — waiting is cheaper than a cache poke

# ── 3. WITH the key: the search finds the seeded player ───────────────────────────────────────────
R=$(lookup "$JAG" email "$SEED_EMAIL")
CODE=${R%% *}; BODY=${R#* }
# 201, not 200: Nest answers a POST with Created, and the lookup is a POST because the searched
# value must ride the body. Both accepted — the assertion is about the ANSWER, not the number.
case "$CODE:$BODY" in
  20[01]:*'"matched":true'*) pass "⭐ the lookup finds the seeded player from inside the ticket (http $CODE)" ;;
  *) fail "the lookup finds the player" "http $CODE body ${BODY:0:120}" ;;
esac
# ⚠️ Guarded: an EMPTY $SEED_PLAYER would make this pattern match anything — the vacuous-pass shape
# this repo has now met four times (and the first run of THIS script produced three of them).
if [ -z "$SEED_PLAYER" ]; then
  fail "the answer carries the player id" "no seeded player — the assertion would be vacuous"
else
  case "$BODY" in
    *"$SEED_PLAYER"*) pass "…and answers with the player id the attach needs" ;;
    *) fail "the answer carries the player id" "${BODY:0:120}" ;;
  esac
fi

# ── 4. ⭐ the trail holds the HASH, never the value ────────────────────────────────────────────────
ENTRY=$(psql users_db "select detail_json::text from \"AuditEntry\" where account_id='$ACC' and action='contact.lookup' order by created_at desc limit 1")
case "$ENTRY" in
  *valueHash*) pass "the audit entry carries a valueHash" ;;
  *) fail "audit entry shape" "${ENTRY:0:120}" ;;
esac
case "$ENTRY" in
  *"$SEED_EMAIL"*) fail "⛔ THE SEARCHED VALUE IS IN THE TRAIL" "the one thing 0044 forbids" ;;
  *) pass "⛔ the searched value appears NOWHERE in the entry (grepped, not assumed)" ;;
esac
TRANS=$(psql chats_db "select payload_json::text from \"ConversationTransition\" where subject_id='$CONV' and type='contact.lookup_performed' order by occurred_at desc limit 1")
case "$TRANS" in
  *valueHash*) pass "the conversation-side transition carries the same token class" ;;
  *) fail "lookup transition written" "${TRANS:0:120}" ;;
esac

# ── 5. attach, and the window says identified ─────────────────────────────────────────────────────
ATT=$(curl -s -o /tmp/w9.body -w '%{http_code}' -b "$JAG" -X PUT "$G/conversations/$CONV/player" \
  -H 'Content-Type: application/json' -d "{\"playerId\":\"$SEED_PLAYER\"}")
[ "$ATT" = "200" ] && pass "the conversation is attached to the player (http 200)" || fail "attach" "http $ATT"
STATE=$(psql chats_db "select identity_state from \"Conversation\" where id='$CONV'")
[ "$STATE" = "identified" ] && pass "…and the row now reads identified" || fail "identity_state after attach" "got '$STATE'"
AUD=$(psql chats_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='conversation.player_attach' and target_ref='$CONV'")
[ "${AUD:-0}" -ge 1 ] && pass "the attach is audited" || fail "attach audited" "rows=$AUD"

# ── 6. a second attach is refused — detach first, never a silent overwrite ─────────────────────────
AGAIN=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG" -X PUT "$G/conversations/$CONV/player" \
  -H 'Content-Type: application/json' -d "{\"playerId\":\"$SEED_PLAYER\"}")
[ "$AGAIN" = "400" ] || [ "$AGAIN" = "409" ] || [ "$AGAIN" = "412" ] && pass "⛔ attaching over an identified ticket is refused (http $AGAIN)" \
  || fail "second attach refused" "http $AGAIN"

# ── 7. detach WARNS FIRST, and the two agree ──────────────────────────────────────────────────────
PREV=$(curl -s -b "$JAG" "$G/conversations/$CONV/player/detach-preview")
case "$PREV" in
  *publicReplies*) pass "the detach preview answers with the harvest (0044 §5's warning)" ;;
  *) fail "detach preview" "${PREV:0:120}" ;;
esac
DET=$(curl -s -b "$JAG" -X DELETE "$G/conversations/$CONV/player")
PREV_N=$(printf '%s' "$PREV" | sed -n 's/.*"publicReplies":\([0-9]*\).*/\1/p')
DET_N=$(printf '%s' "$DET" | sed -n 's/.*"publicReplies":\([0-9]*\).*/\1/p')
# ⚠️ Non-emptiness FIRST: two empty strings compare equal, which is how this line passed on a pair
# of 403s in the first run (`gotchas/vacuous-pass-in-live-scripts`, applied to itself).
if [ -z "$PREV_N" ] || [ -z "$DET_N" ]; then
  fail "preview vs outcome" "one of them carried no count (preview='$PREV_N' detach='$DET_N')"
elif [ "$PREV_N" = "$DET_N" ]; then
  pass "…and the warning matches the outcome ($PREV_N replies both times)"
else
  fail "preview vs outcome" "preview=$PREV_N detach=$DET_N"
fi
STATE=$(psql chats_db "select identity_state from \"Conversation\" where id='$CONV'")
# ⚠️ This one passed vacuously in run one too — the row had never been attached, so "unidentified
# again" was just "unidentified still". The attach leg above now has to have succeeded first.
PLID=$(psql chats_db "select coalesce(player_id,'') from \"Conversation\" where id='$CONV'")
if [ "$STATE" = "unidentified" ] && [ -z "$PLID" ] && [ "$ATT" = "200" ]; then
  pass "the row is unidentified again — attach is reversible"
else
  fail "identity_state after detach" "state='$STATE' player='$PLID' (attach http $ATT)"
fi

# ── 8. ⛔ there is no directory: no route lists players by contact ─────────────────────────────────
NOROUTE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG" "$G/players?email=$SEED_EMAIL")
[ "$NOROUTE" = "400" ] || [ "$NOROUTE" = "403" ] && pass "⛔ /players refuses an email filter (http $NOROUTE) — no browsable directory" \
  || fail "no contact filter on /players" "http $NOROUTE"
NOGLOBAL=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG" -X POST "$G/contact-lookup" -H 'Content-Type: application/json' -d '{"kind":"email","value":"x@y.test"}')
[ "$NOGLOBAL" = "404" ] && pass "⛔ there is no account-level lookup route (404) — the absence IS the feature" \
  || fail "no global lookup route" "http $NOGLOBAL"

# ── 9. the rate cap, and its refusal audited ──────────────────────────────────────────────────────
# 20/hour: the run above spent 1–2, so 25 more crosses it in either run of the pair.
CAPPED=""
i=0
while [ $i -lt 25 ]; do
  C=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAG" -X POST "$G/conversations/$CONV/contact-lookup" \
    -H 'Content-Type: application/json' -d "{\"kind\":\"email\",\"value\":\"cap-$RUN-$i@example.test\"}")
  [ "$C" = "429" ] && { CAPPED=$i; break; }
  i=$((i+1))
done
[ -n "$CAPPED" ] && pass "⭐ the cap refuses (http 429) after $CAPPED further lookups in the window" \
  || fail "rate cap" "25 more lookups all passed"
CAPAUD=$(psql users_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='contact.lookup' and detail_json::text like '%rate_capped%'")
[ "${CAPAUD:-0}" -ge 1 ] && pass "…and the REFUSAL is itself audited (volume is the only signal there is)" \
  || fail "capped attempt audited" "rows=$CAPAUD"

echo
echo "W9 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
