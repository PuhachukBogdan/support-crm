#!/usr/bin/env bash
# MVP block W19 — live round (subpoints 5.4 + 5.5): my avatar, my status.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
#   ⭐ the avatar rides feature 016's ONE ingest path: real bytes in, MAGIC-BYTE validation (a text
#     file wearing .png is refused), the always-made 256px derivative served back;
#   ⛔ the reference is OWNED: someone else's upload answers like a nonexistent one (404) — setting
#     a face is not a way to claim another person's file;
#   ⭐ presence: my own PUT flips the state the ROUTER reads (031 proved «away is not routed» live in
#     W5's 21/21; here the self-service flip is the new surface).
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Presence is restored to online; each run leaves one claimed
# avatar upload (the previous reference is retention's to collect — ADR 0015, said in the schema).
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
ROLE_PW='Stand#Role7x'

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

JA=$(login "role-support-agent@beton.win" "$ROLE_PW")
grep -q access "$JA" && pass "the agent's session (both surfaces are self-scoped)" \
  || { fail "agent session" "no cookie"; echo "W19 live: $ok ok, $bad failed"; exit 1; }
JB=$(login "role-teamlead@beton.win" "$ROLE_PW")
grep -q access "$JB" && pass "a second person's session (the ownership negative)" || fail "teamlead session" "no cookie"

# ── 1. ⭐ the avatar: real bytes through the one ingest path ────────────────────────────────────────
# A genuine 1×1 PNG. The purpose validates by CONTENT, so the fixture must be a real image.
PNG=/tmp/w19-avatar.png
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$PNG"
UP=$(curl -s -o /tmp/w19.up -w '%{http_code}' -b "$JA" -X POST "$G/uploads/avatar" -F "file=@$PNG;type=image/png")
UPID=$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' /tmp/w19.up | head -1)
if { [ "$UP" = "201" ] || [ "$UP" = "200" ]; } && [ -n "$UPID" ]; then
  pass "⭐ the bytes went through 016's one ingest path (upload $UPID)"
else
  fail "avatar upload" "http $UP — $(head -c 120 /tmp/w19.up)"
fi

SET=$(curl -s -o /tmp/w19.set -w '%{http_code}' -b "$JA" -X PUT "$G/me/operator/avatar" \
  -H 'Content-Type: application/json' -d "{\"uploadId\":\"$UPID\"}")
if [ "$SET" = "200" ] && grep -q "\"avatarUploadId\":\"$UPID\"" /tmp/w19.set; then
  pass "…PUT /me/operator/avatar placed the reference"
else
  fail "set avatar" "http $SET — $(head -c 120 /tmp/w19.set)"
fi
ME=$(curl -s -b "$JA" "$G/me/operator")
case "$ME" in
  *"$UPID"*) pass "…and GET /me/operator carries it — the profile read is the receipt" ;;
  *) fail "avatar on the profile read" "${ME:0:120}" ;;
esac
THUMB=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' -b "$JA" "$G/uploads/$UPID/thumb")
case "$THUMB" in
  "200 image/"*) pass "⭐ the 256px derivative serves ($THUMB) — a photo costs a row nothing" ;;
  *) fail "thumb serves" "$THUMB" ;;
esac
JBREAD=$(curl -s -o /dev/null -w '%{http_code}' -b "$JB" "$G/uploads/$UPID/thumb")
[ "$JBREAD" = "200" ] && pass "…and a COLLEAGUE can see it — an avatar is for others (purpose permission: null)" \
  || fail "colleague reads avatar" "http $JBREAD"

# ── 2. ⛔ the refusals ──────────────────────────────────────────────────────────────────────────────
TXT=/tmp/w19-not-an-image.png
printf 'this is text wearing a png name' > "$TXT"
BADUP=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X POST "$G/uploads/avatar" -F "file=@$TXT;type=image/png")
[ "$BADUP" = "400" ] && pass "⛔ a text file wearing .png is refused (400) — magic bytes, not the claimed type" \
  || fail "magic-byte refusal" "http $BADUP"
GHOST=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PUT "$G/me/operator/avatar" \
  -H 'Content-Type: application/json' -d '{"uploadId":"no-such-upload"}')
[ "$GHOST" = "404" ] && pass "⛔ a nonexistent upload id is 404" || fail "ghost id refused" "http $GHOST"
UPB=$(curl -s -b "$JB" -X POST "$G/uploads/avatar" -F "file=@$PNG;type=image/png" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
THEIRS=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PUT "$G/me/operator/avatar" \
  -H 'Content-Type: application/json' -d "{\"uploadId\":\"$UPB\"}")
[ "$THEIRS" = "404" ] && pass "⛔ SOMEONE ELSE'S upload answers like a nonexistent one — no existence oracle, no face theft" \
  || fail "ownership on the reference" "http $THEIRS"

# ── 3. ⭐ presence: my own flip, on the store the router reads ─────────────────────────────────────
P0=$(curl -s -b "$JA" "$G/presence/me" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
[ -n "$P0" ] && pass "GET /presence/me answers ($P0)" || fail "presence read" "empty"
AWAY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PUT "$G/presence/me" \
  -H 'Content-Type: application/json' -d '{"state":"away"}')
P1=$(curl -s -b "$JA" "$G/presence/me" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
if [ "$AWAY" = "200" ] && [ "$P1" = "away" ]; then
  pass "⭐ «перерыв»: my own PUT flipped the state the ROUTER reads (031's «away is not routed», proven in W5)"
else
  fail "presence flip" "http $AWAY, state '$P1'"
fi
BADSTATE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PUT "$G/presence/me" \
  -H 'Content-Type: application/json' -d '{"state":"napping"}')
[ "$BADSTATE" = "400" ] && pass "⛔ an unknown state is refused (400) — the vocabulary is the server's" \
  || fail "unknown state refused" "http $BADSTATE"
curl -s -o /dev/null -b "$JA" -X PUT "$G/presence/me" -H 'Content-Type: application/json' -d '{"state":"online"}'
P2=$(curl -s -b "$JA" "$G/presence/me" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')
[ "$P2" = "online" ] && pass "…and back on shift — restored for the next run" || fail "restore presence" "state '$P2'"

echo
echo "W19 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
