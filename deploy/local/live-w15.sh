#!/usr/bin/env bash
# MVP block W15 — live round (subpoint 3.10, roadmap 6.8 minimum): the channels admin surface.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The operator's named outcome: «добавляю почтовый адрес и вижу ключ API-канала». This round asserts
# the wire under that screen, and the block's invariant — SERVER-SIDE RBAC on tenant configuration:
# a channel row decides which tenant/brand an arriving delivery belongs to, so a teamlead must get a
# real 403 from the server, not a hidden button.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Writes use a per-run address and the original is restored at the
# end; the brand-2 leg CREATES on the first ever run and UPDATES on every later one — both are the
# same PUT and both must answer 200.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'
OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}"
OWNER_PW="${OWNER_PW:-m13aP1LLB07vyh#7A}"
BRAND1=seed-brand-0000-0000-000000000001
BRAND2=seed-brand-0000-0000-000000000002
BRAND1_ADDR='support-brand1@stand.test'   # the seeded address, restored at the end
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

audits(){ psql chats_db "select count(*) from \"AuditEntry\" where account_id='$ACC' and action='channel.config_changed'"; }

JOWNER=$(login "$OWNER_EMAIL" "$OWNER_PW")
grep -q access "$JOWNER" && pass "owner session" \
  || { fail "owner session" "no cookie"; echo "W15 live: $ok ok, $bad failed"; exit 1; }
JLEAD=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JLEAD" && pass "teamlead session (the negative-control caller)" \
  || fail "teamlead session" "no cookie"

# ── 1. ⭐ the list exists, and the operator can SEE the API-channel key ────────────────────────────
LIST=$(curl -s -b "$JOWNER" "$G/admin/channels")
case "$LIST" in
  *'"channels"'*'"key"'*) pass "⭐ GET /admin/channels answers — the product can show its own channels" ;;
  *) fail "channels list" "${LIST:0:140}" ;;
esac
case "$LIST" in
  *stand-api-brand1*) pass "⭐ …and the API-channel KEY is visible («вижу ключ API-канала»)" ;;
  *) fail "api key visible" "${LIST:0:140}" ;;
esac
case "$LIST" in
  *'"kind":"email"'*'"address"'*|*'"address"'*'"kind":"email"'*) pass "…and the email channel carries its address" ;;
  *) fail "email address on the list" "${LIST:0:140}" ;;
esac

# ⛔ The KEY is public configuration; the SECRET must not ride the same wire. Read the real secret
# from the stand's .env and assert its absence — a negative control with a known-present value.
SECRET=$(grep '^CHANNEL_SECRETS=' .env 2>/dev/null | sed 's/^CHANNEL_SECRETS=//' | tr ',' '\n' | sed -n 's/^stand-api-brand1://p' | head -1 | tr -d '\r')
if [ -n "$SECRET" ]; then
  case "$LIST" in
    *"$SECRET"*) fail "⛔ the channel secret leaked onto the admin wire" "present in the response" ;;
    *) pass "⛔ the channel SECRET does not appear on the wire (checked against the real value)" ;;
  esac
else
  say "NOTE: no stand-api-brand1 secret in .env — the no-secret assertion had nothing to check" "-"
fi

# ── 2. ⛔ the block's invariant, live: tenant configuration is refused below the key ───────────────
LEAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" "$G/admin/channels")
[ "$LEAD_CODE" = "403" ] && pass "⛔ a teamlead is REFUSED the channels list (403 — server-side, not a hidden button)" \
  || fail "teamlead refused" "http $LEAD_CODE"
LEAD_PUT=$(curl -s -o /dev/null -w '%{http_code}' -b "$JLEAD" -X PUT "$G/admin/channels/email/$BRAND1" \
  -H 'Content-Type: application/json' -d '{"address":"intruder@stand.test"}')
[ "$LEAD_PUT" = "403" ] && pass "⛔ …and the write is refused the same way" \
  || fail "teamlead write refused" "http $LEAD_PUT"

# ── 3. ⭐ the one write: change brand 1's mail address ─────────────────────────────────────────────
NEWADDR="w15-$RANDOM@stand.test"
A0=$(audits)
PUT=$(curl -s -o /tmp/w15.put -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/channels/email/$BRAND1" \
  -H 'Content-Type: application/json' -d "{\"address\":\"$NEWADDR\"}")
if [ "$PUT" = "200" ] && grep -q "\"address\":\"$NEWADDR\"" /tmp/w15.put; then
  pass "⭐ PUT places the new address and answers with the row ($NEWADDR)"
else
  fail "address change" "http $PUT — $(head -c 120 /tmp/w15.put)"
fi
LIST2=$(curl -s -b "$JOWNER" "$G/admin/channels")
case "$LIST2" in
  *"$NEWADDR"*) pass "…and the list is the receipt — the new address is on it" ;;
  *) fail "address on the list" "not present after the write" ;;
esac
A1=$(audits)
[ "$((A1 - A0))" = "1" ] && pass "…and the change is audited, exactly once (channel.config_changed +1)" \
  || fail "audit on change" "delta $((A1 - A0))"

# ── 4. a no-op is refused and leaves NO audit entry ───────────────────────────────────────────────
NOOP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/channels/email/$BRAND1" \
  -H 'Content-Type: application/json' -d "{\"address\":\"$NEWADDR\"}")
A2=$(audits)
if [ "$NOOP" = "400" ] && [ "$A2" = "$A1" ]; then
  pass "the address it already has is refused (400) and writes nothing — an entry recording no change is noise"
else
  fail "no-op refused" "http $NOOP, audit delta $((A2 - A1))"
fi

# ── 5. a non-address is refused before anything is written ────────────────────────────────────────
BADADDR=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/channels/email/$BRAND1" \
  -H 'Content-Type: application/json' -d '{"address":"not an address"}')
[ "$BADADDR" = "400" ] && pass "a non-address is refused (400)" || fail "invalid address refused" "http $BADADDR"

# ── 6. ⭐ «добавляю почтовый адрес»: brand 2 gets one (created first run, updated later) ───────────
ADDR2="w15-two-$RANDOM@stand.test"
A3=$(audits)
PUT2=$(curl -s -o /tmp/w15.put2 -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/channels/email/$BRAND2" \
  -H 'Content-Type: application/json' -d "{\"address\":\"$ADDR2\"}")
if [ "$PUT2" = "200" ] && grep -q '"kind":"email"' /tmp/w15.put2; then
  pass "⭐ brand 2's mail address is placed (create-or-update, same PUT)"
else
  fail "brand 2 address" "http $PUT2 — $(head -c 120 /tmp/w15.put2)"
fi
# The row's key was GENERATED by the server (em-…) — never chosen by the caller.
KEY2=$(sed -n 's/.*"key":"\([^"]*\)".*/\1/p' /tmp/w15.put2)
case "$KEY2" in
  em-*|stand-email-*) pass "…and its key is the server's ($KEY2)" ;;
  *) fail "generated key" "key '$KEY2'" ;;
esac
A4=$(audits)
[ "$((A4 - A3))" = "1" ] && pass "…audited, exactly once" || fail "audit on brand-2 write" "delta $((A4 - A3))"

# ── 7. restore brand 1, so the next run starts where this one did ─────────────────────────────────
RESTORE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JOWNER" -X PUT "$G/admin/channels/email/$BRAND1" \
  -H 'Content-Type: application/json' -d "{\"address\":\"$BRAND1_ADDR\"}")
[ "$RESTORE" = "200" ] && pass "brand 1's seeded address is restored" || fail "restore" "http $RESTORE"

echo
echo "W15 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
