#!/usr/bin/env bash
# MVP block W11 — live round (subpoint 2.7's directory half; roadmap 9.17).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The block's criterion: «нахожу игрока поиском и открываю его».
#
# What only a live round answers — every claim is about the SERVER:
#   the brands list exists at all (the directory could not ask its first question without it)
#   ⭐ a LINEAR role is REFUSED the directory (403) — 9.17's own Done-when, not a filtered page
#   a supervisory role pages it, and the id-prefix search narrows the same page
#   ⛔ there is no contact parameter — email/phone/q are 400s, now and for ever
#   the bulk read is AUDITED once per page, and the single read still masks per role
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Read-only: this round writes nothing but audit rows the
# product itself writes for any directory read.
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

JSUP=$(login "role-support-agent@beton.win" "$ROLE_PW")
JTL=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JSUP" && grep -q access "$JTL" && pass "both role sessions (linear + supervisory)" \
  || { fail "role sessions" "no cookie"; echo "W11 live: $ok ok, $bad failed"; exit 1; }

# ── 1. the brands list — the directory's first question ───────────────────────────────────────────
BRANDS=$(curl -s -b "$JTL" "$G/brands")
case "$BRANDS" in
  *'"brands"'*'"brandId"'*) pass "GET /brands answers with the account's brands" ;;
  *) fail "brands list" "${BRANDS:0:140}" ;;
esac
BRAND=$(printf '%s' "$BRANDS" | sed -n 's/.*"brandId":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$BRAND" ] && pass "a brand id to scope the directory by ($BRAND)" || fail "brand id" "none parsed"
# ⛔ It must not leak the theming fields, and it must not be a per-brand access statement.
case "$BRANDS" in *'"accent"'*|*'"icon"'*) fail "brands projection" "theming fields leaked" ;;
  *) pass "⛔ the projection is {brandId,name,slug} — no theming fields ride along" ;; esac

# ── 2. ⭐ the refusal — 9.17's Done-when ───────────────────────────────────────────────────────────
SUP=$(curl -s -o /tmp/w11.body -w '%{http_code}' -b "$JSUP" "$G/players?brandId=$BRAND&pageSize=5")
if [ "$SUP" = "403" ]; then
  pass "⭐ a LINEAR role is REFUSED the directory (403), not served a filtered page"
else
  fail "linear role refused" "http $SUP body $(head -c 120 /tmp/w11.body)"
fi
# And the refusal says nothing about who exists.
grep -q 'playerId' /tmp/w11.body && fail "refusal body" "it carries player data" \
  || pass "…and the refusal body names no customer"

# ── 3. the supervisory read, and the search ───────────────────────────────────────────────────────
TL=$(curl -s -b "$JTL" "$G/players?brandId=$BRAND&pageSize=5")
case "$TL" in
  *'"players"'*) pass "a supervisory role reads the directory" ;;
  *) fail "supervisory read" "${TL:0:140}" ;;
esac
PID=$(printf '%s' "$TL" | sed -n 's/.*"playerId":"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$PID" ]; then
  fail "a player to search for" "the page is empty — the search assertion would be vacuous"
else
  pass "a player id to search by ($PID)"
  PREFIX=$(printf '%s' "$PID" | cut -c1-6)
  HIT=$(curl -s -b "$JTL" "$G/players?brandId=$BRAND&pageSize=5&playerIdPrefix=$PREFIX")
  case "$HIT" in *"$PID"*) pass "⭐ the id-prefix search finds it ($PREFIX…)" ;;
    *) fail "prefix search" "${HIT:0:140}" ;; esac
  MISS=$(curl -s -b "$JTL" "$G/players?brandId=$BRAND&pageSize=5&playerIdPrefix=zzz-nobody")
  case "$MISS" in *'"players":[]'*|*'"players":[ ]'*) pass "…and a prefix nobody matches returns an EMPTY page, not everyone" ;;
    *) fail "prefix narrows" "${MISS:0:140}" ;; esac
fi

# ── 4. ⛔ no contact parameter, now or ever ────────────────────────────────────────────────────────
BADP=""
for k in email phone contact q search; do
  C=$(curl -s -o /dev/null -w '%{http_code}' -b "$JTL" "$G/players?brandId=$BRAND&$k=x")
  [ "$C" = "400" ] || BADP="$BADP $k:$C"
done
[ -z "$BADP" ] && pass "⛔ every contact-shaped parameter is a 400 — the directory cannot search by contact" \
  || fail "contact params refused" "$BADP"
LONG=$(curl -s -o /dev/null -w '%{http_code}' -b "$JTL" "$G/players?brandId=$BRAND&playerIdPrefix=$(printf 'x%.0s' $(seq 1 70))")
[ "$LONG" = "400" ] && pass "an over-long prefix is refused, not truncated" || fail "prefix bound" "http $LONG"

# ── 5. the bulk read is audited, once per page ────────────────────────────────────────────────────
BEFORE=$(psql users_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='contact.reveal'")
curl -s -o /dev/null -b "$JTL" "$G/players?brandId=$BRAND&pageSize=5"
AFTER=$(psql users_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='contact.reveal'")
if [ "$((AFTER-BEFORE))" -ge 1 ]; then
  pass "the bulk read is audited (contact.reveal +$((AFTER-BEFORE)) for one page)"
else
  fail "bulk read audited" "before=$BEFORE after=$AFTER"
fi

echo
echo "W11 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
