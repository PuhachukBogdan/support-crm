#!/usr/bin/env bash
# MVP block W18 — live round (subpoints 5.2 + 5.3): personal settings + the theme that follows you.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The wire under the settings screen, asserted AS AN AGENT — the point of this block's rail fix is
# that the personal surface belongs to every signed-in person, not to holders of an admin key.
#
#   ⭐ the theme is stored per PERSON: a SECOND session of the same person reads the value the first
#     one wrote — that is "follows you to any machine" on the wire;
#   ⛔ a wrong value is refused 400 NAMING THE KEY (feature 021's one deliberate pass-through), and
#     an unknown key is refused — never silently dropped.
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. The original value is read first and restored at the end.
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

theme_of(){ curl -s -b "$1" "$G/me/ui-preferences" | sed -n 's/.*"theme_mode":"\([^"]*\)".*/\1/p'; }

JA=$(login "role-support-agent@beton.win" "$ROLE_PW")
grep -q access "$JA" && pass "a LINE AGENT's session — the personal surface is theirs (the rail fix's point)" \
  || { fail "agent session" "no cookie"; echo "W18 live: $ok ok, $bad failed"; exit 1; }

# ── 1. the preference read answers, and remembers what to restore ─────────────────────────────────
ORIG=$(theme_of "$JA")
case "$ORIG" in
  light|dark) pass "GET /me/ui-preferences answers with a theme ($ORIG)" ;;
  *) fail "preferences read" "theme_mode='$ORIG'" ;;
esac
TARGET=$([ "$ORIG" = "dark" ] && echo light || echo dark)

# ── 2. ⭐ the write, and the cross-session read — "follows you to any machine", on the wire ────────
SET=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/me/ui-preferences" \
  -H 'Content-Type: application/json' -d "{\"values\":{\"theme_mode\":\"$TARGET\"}}")
[ "$SET" = "200" ] && pass "the agent sets $TARGET (200)" || fail "set theme" "http $SET"
NOW=$(theme_of "$JA")
[ "$NOW" = "$TARGET" ] && pass "…and reads it back" || fail "read back" "theme_mode='$NOW'"

JB=$(login "role-support-agent@beton.win" "$ROLE_PW")
CROSS=$(theme_of "$JB")
[ "$CROSS" = "$TARGET" ] && pass "⭐ a SECOND session of the same person reads $TARGET — the theme follows the PERSON" \
  || fail "cross-session theme" "theme_mode='$CROSS'"

# ── 3. ⛔ refusals: a wrong value names the KEY; an unknown key is never dropped ───────────────────
BADVAL=$(curl -s -o /tmp/w18.bad -w '%{http_code}' -b "$JA" -X PATCH "$G/me/ui-preferences" \
  -H 'Content-Type: application/json' -d '{"values":{"theme_mode":"neon"}}')
if [ "$BADVAL" = "400" ] && grep -q 'theme_mode' /tmp/w18.bad; then
  pass "⛔ a wrong value is 400 NAMING the key — the screen can say WHICH control is wrong"
else
  fail "wrong value refused by name" "http $BADVAL — $(head -c 100 /tmp/w18.bad)"
fi
BADKEY=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/me/ui-preferences" \
  -H 'Content-Type: application/json' -d '{"values":{"wallpaper":"cats"}}')
[ "$BADKEY" = "400" ] && pass "⛔ an unknown preference key is refused (400), never silently dropped" \
  || fail "unknown key refused" "http $BADKEY"
STILL=$(theme_of "$JA")
[ "$STILL" = "$TARGET" ] && pass "…and the refusals wrote nothing — the theme is untouched" \
  || fail "refusals wrote nothing" "theme_mode='$STILL'"

# ── 4. restore ─────────────────────────────────────────────────────────────────────────────────────
REST=$(curl -s -o /dev/null -w '%{http_code}' -b "$JA" -X PATCH "$G/me/ui-preferences" \
  -H 'Content-Type: application/json' -d "{\"values\":{\"theme_mode\":\"$ORIG\"}}")
[ "$REST" = "200" ] && pass "the original theme ($ORIG) is restored" || fail "restore" "http $REST"

echo
echo "W18 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
