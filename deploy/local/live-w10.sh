#!/usr/bin/env bash
# MVP block W10 — live round (subpoints 2.7 + 2.8; roadmap 9.4 / 9.11 / 4.13, and ⭐ 3.7).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# ⭐⭐ THE POINT OF THIS ROUND IS 3.7 — **field masking, proven on the wire for the first time.**
#
# The plan has carried this line since the MVP was written: *«живая проводка маскирования полей по
# роли — код есть, вживую ни разу не проверялся»*. The claim under test is stronger than "the agent
# sees less": a withheld field must be **ABSENT from the response**, not present-and-empty. An empty
# string travels as "we have nothing"; an absent key travels as "you were not shown this" — and only
# the second is unusable by a screen that would otherwise render a blank where a value belongs.
#
# It is proven by DIFFING two real responses for the SAME player, fetched by two real logins whose
# only difference is their role. Nothing is asserted from a fixture.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Read-only: this round writes nothing at all.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'
ACC=seed-account-0000-0000-000000000001

ok=0; bad=0
say(){ printf "%-78s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
note(){ say "$1" "note"; }
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }
keys_of(){ printf '%s' "$1" | tr ',' '\n' | sed -n 's/.*"\([a-zA-Z]*\)":.*/\1/p' | sort | tr '\n' ' '; }

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

# ── preflight ─────────────────────────────────────────────────────────────────────────────────────
PLAYER=$(psql users_db "select player_id from \"Player\" where account_id='$ACC' order by player_id limit 1")
BRAND=$(psql users_db "select brand_id from \"Player\" where account_id='$ACC' order by player_id limit 1")
[ -n "$PLAYER" ] && [ -n "$BRAND" ] && pass "preflight: a seeded player to read ($PLAYER)" \
  || { fail "preflight: seeded player" "users_db has none"; echo "W10 live: $ok ok, $bad failed"; exit 1; }

# ⚠️ The fixture check the 08-05 lesson demands: the roles must actually DIFFER on this stand, or the
# diff below would prove nothing while looking green.
SUP_ROLE=$(psql auth_db "select r.key from \"UserRole\" ur join \"User\" u on u.id=ur.user_id join \"Role\" r on r.id=ur.role_id where u.email='role-support-agent@beton.win'")
AM_ROLE=$(psql auth_db "select r.key from \"UserRole\" ur join \"User\" u on u.id=ur.user_id join \"Role\" r on r.id=ur.role_id where u.email='role-teamlead@beton.win'")
[ "$SUP_ROLE" = "support_agent" ] && [ "$AM_ROLE" = "teamlead" ] \
  && pass "preflight: the two probe logins really hold DIFFERENT roles ($SUP_ROLE vs $AM_ROLE)" \
  || fail "preflight: probe roles" "support='$SUP_ROLE' other='$AM_ROLE'"

JSUP=$(login "role-support-agent@beton.win" "$ROLE_PW")
JTL=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JSUP" && grep -q access "$JTL" && pass "both role sessions" \
  || { fail "role sessions" "no cookie"; echo "W10 live: $ok ok, $bad failed"; exit 1; }

# ── 1. ⭐⭐ 3.7 — the same player, two roles, and the DIFFERENCE is absence ─────────────────────────
BSUP=$(curl -s -b "$JSUP" "$G/players/$PLAYER?brandId=$BRAND")
BTL=$(curl -s -b "$JTL"  "$G/players/$PLAYER?brandId=$BRAND")
KSUP=$(keys_of "$BSUP"); KTL=$(keys_of "$BTL")

case "$BSUP" in *'"playerId"'*) pass "the support agent CAN read the player (masking is not a refusal)" ;;
  *) fail "support agent reads the player" "${BSUP:0:120}" ;; esac
note "  support keys: $KSUP"
note "  teamlead keys: $KTL"

if [ "$KSUP" = "$KTL" ]; then
  fail "⭐⭐ the two roles receive DIFFERENT field sets" "identical keys — masking is doing nothing on the wire"
else
  pass "⭐⭐ 3.7 PROVEN LIVE: the two roles receive different field sets"
fi

# The narrower role must be a strict SUBSET — masking may only remove.
EXTRA=""
for k in $KSUP; do case " $KTL " in *" $k "*) ;; *) EXTRA="$EXTRA $k" ;; esac; done
[ -z "$EXTRA" ] && pass "…and the agent's fields are a strict SUBSET of the wider role's" \
  || fail "subset" "agent has keys the teamlead lacks:$EXTRA"

# ⭐ The one that matters: a withheld field is ABSENT, never present-and-empty.
MISSING=""
for k in $KTL; do case " $KSUP " in *" $k "*) ;; *) MISSING="$MISSING $k" ;; esac; done
if [ -z "$MISSING" ]; then
  fail "a withheld field exists to check" "the wider role gained nothing — nothing was withheld"
else
  pass "the wider role sees more:$MISSING"
  BAD=""
  for k in $MISSING; do
    case "$BSUP" in *"\"$k\""*) BAD="$BAD $k" ;; esac
  done
  [ -z "$BAD" ] && pass "⭐⭐ every withheld field is ABSENT from the agent's response, not blanked" \
    || fail "withheld fields are absent" "present (probably empty) in the agent's body:$BAD"
fi

# ⛔ And nothing that was withheld leaked into the OTHER read the card makes.
SUM=$(curl -s -b "$JSUP" "$G/players/$PLAYER/contact-summary?brandId=$BRAND")
BADSUM=""
for k in $MISSING; do case "$SUM" in *"\"$k\""*) BADSUM="$BADSUM $k" ;; esac; done
[ -z "$BADSUM" ] && pass "⛔ the contact summary is not a back door for the withheld fields" \
  || fail "summary leaks withheld fields" "$BADSUM"

# ── 2. the card's second read: contact history (4.13) ─────────────────────────────────────────────
case "$SUM" in
  *'"conversationCount"'*) pass "the contact summary answers with counts (4.13, the card's history)" ;;
  *) fail "contact summary" "${SUM:0:140}" ;;
esac
# The contract test forbids contact VALUES here; prove it on a real body too.
# ⚠️ The first version of this check FAILED on a healthy body: it looked for the string `"email"`,
# which is the CHANNEL NAME (`{"channel":"email"}`) — a word, not an address. A pattern that cannot
# tell a field's name from a contact's value proves nothing about either. So: an address SHAPE
# (`@` with a dot after it) and the field NAMES with their colons.
LEAK=""
printf '%s' "$SUM" | grep -qE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' && LEAK="$LEAK an-address"
printf '%s' "$SUM" | grep -qE '"(email|phone|address|handle)"[[:space:]]*:' && LEAK="$LEAK a-contact-field"
printf '%s' "$SUM" | grep -qE '\+[0-9]{9,}' && LEAK="$LEAK a-phone-number"
[ -z "$LEAK" ] && pass "⛔ no contact value anywhere in the summary body (contract, proven live)" \
  || fail "a contact value reached the summary" "$LEAK"
NOBRAND=$(curl -s -o /dev/null -w '%{http_code}' -b "$JSUP" "$G/players/$PLAYER/contact-summary")
[ "$NOBRAND" = "400" ] && pass "⛔ the summary REFUSES without a brand (one id, two brands, two people)" \
  || fail "summary requires brandId" "http $NOBRAND"

# ── 3. the rail's own view — the Active-tickets tab asks the server this exact question ────────────
OPID=$(curl -s -b "$JSUP" "$G/me/operator" | sed -n 's/.*"operatorId":"\([^"]*\)".*/\1/p')
[ -n "$OPID" ] && pass "the agent resolves their own operator id (5.11)" || fail "me/operator" "empty"
RAIL=$(curl -s -b "$JSUP" "$G/conversations?assigneeOperatorId=$OPID&openedByOperatorId=$OPID&statusCategories=new,open&pageSize=5")
case "$RAIL" in
  *'"conversations"'*) pass "the rail view answers (assigned to me ∧ opened by me ∧ new,open)" ;;
  *) fail "rail view" "${RAIL:0:140}" ;;
esac
# ⚠️ R17a's LEAVE rule, proven by construction: asking for new,open cannot return a pending ticket.
PEND=$(printf '%s' "$RAIL" | grep -o '"statusKey":"[a-z_]*"' | grep -c 'pending' || true)
[ "${PEND:-0}" = "0" ] && pass "⛔ no Pending ticket is on the rail — R17a's «leaves at Pending», by predicate" \
  || fail "pending on the rail" "$PEND rows"

echo
echo "W10 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
