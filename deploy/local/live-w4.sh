#!/usr/bin/env bash
# MVP block W4 — live round (roadmap 7.1, feature 034).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The operator's acceptance criterion for the whole block:
#   «новый тикет и новое сообщение появляются без обновления страницы»
#
# So this script makes a stranger's mail arrive and then reads what a BROWSER'S SOCKET was told —
# nothing here inspects the code. What it can answer that no unit test can:
#
#   the socket is authorized by the same cookie REST uses, and one WITHOUT it is closed
#   a ticket arriving by itself produces `conversation.created` + `message.created` on a live socket
#   an event published to ANOTHER account's channel reaches this socket not at all
#   the frames carry no subject, no address, no body — asserted on the bytes a browser received
#   no service log line carries the customer's words
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY. Every identifier is unique per run and nothing is cleaned up.
#
# ⓘ THE OTHER HALF OF THIS BLOCK IS NOT HERE. "A row appears in a list nobody is touching" is a
# statement about a rendered page, and jsdom has no layout — see T041: a headed browser, the Inbox
# open, hands off the keyboard. This script proves the wire; a person proves the screen.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025            # mailpit — login codes only
GM_SMTP=127.0.0.1:3025             # greenmail SMTP: where the "customer" posts from
SEED_PW='Stand#Seed7x'
AGENT=seed-agent1@example.test
ACC=seed-account-0000-0000-000000000001
SUPPORT=support-brand1@stand.test
CUSTOMER=live-w4-player@stand.test

RUN=$(date +%s)
ok=0; bad=0
say(){ printf "%-72s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
# ⚠️ `tr -d '\r'` only. W3's script deleted spaces too, which strips them from INSIDE a value and made
# a perfectly correct subject fail its assertion.
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

login_token(){ # $1 email $2 password → prints the raw access token
  local ch code jar
  ch=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
  sleep 3
  code=$(code_of "$1")
  jar=$(mktemp)
  curl -s -c "$jar" -X POST $G/auth/verify -H 'Content-Type: application/json' \
    -d "{\"challengeId\":\"$ch\",\"code\":\"$code\"}" >/dev/null
  awk '$6=="access"{print $7}' "$jar"
}

TOKEN=$(login_token "$AGENT" "$SEED_PW")
[ -n "$TOKEN" ] && pass "agent session (the socket will use this cookie)" \
  || { fail "agent session" "no access cookie"; echo; echo "W4 live: $ok ok, $bad failed"; exit 1; }

# ── the socket capture ───────────────────────────────────────────────────────────────────────────
# Runs INSIDE the gateway container: `ws` is already there (it is what serves the socket), and
# `localhost:3000` inside that container is the gateway itself. Nothing is installed on the host.
#
# It opens TWO sockets — one carrying the cookie, one carrying nothing — and prints what each saw as
# JSON lines, so every assertion below is made against the bytes a browser would have received.
CAP=$(mktemp)
docker compose exec -T -e W4_TOKEN="$TOKEN" -e W4_SECONDS=45 gateway node -e '
const WebSocket = require("ws");
const token = process.env.W4_TOKEN;
const ms = Number(process.env.W4_SECONDS) * 1000;
const out = (o) => console.log(JSON.stringify(o));
const withCookie = new WebSocket("ws://localhost:3000", { headers: { cookie: "access=" + token } });
const without  = new WebSocket("ws://localhost:3000");
withCookie.on("open", () => out({ who: "authed", ev: "open" }));
withCookie.on("message", (d) => out({ who: "authed", ev: "frame", raw: d.toString() }));
withCookie.on("close", (c) => out({ who: "authed", ev: "close", code: c }));
without.on("open", () => out({ who: "anon", ev: "open" }));
without.on("message", (d) => out({ who: "anon", ev: "frame", raw: d.toString() }));
without.on("close", (c) => out({ who: "anon", ev: "close", code: c }));
setTimeout(() => { try { withCookie.close(); without.close(); } catch {} process.exit(0); }, ms);
' > "$CAP" 2>&1 &
CAP_PID=$!
sleep 5   # let both handshakes settle before anything is triggered

# ── a stranger's mail arrives, from outside every service ────────────────────────────────────────
SUBJ="Живое обновление $RUN"
MSGID="<live-w4-in-$RUN@stand.test>"
MAIL=$(mktemp)
{
  printf 'From: %s\r\n' "$CUSTOMER"
  printf 'To: %s\r\n' "$SUPPORT"
  printf 'Subject: %s\r\n' "$SUBJ"
  printf 'Message-ID: %s\r\n' "$MSGID"
  printf 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n'
  printf '\r\nпроверяем живое обновление, ничего не нажимаю\r\n'
} > "$MAIL"
curl -s --url "smtp://$GM_SMTP" --mail-from "$CUSTOMER" --mail-rcpt "$SUPPORT" --upload-file "$MAIL" \
  && pass "the customer's mail was accepted by the mail server" \
  || fail "the customer's mail was accepted by the mail server" "smtp refused"

# ⭐ The live isolation negative. Only ONE account exists on this stand, so a second real login is not
# available — see the NOTE printed below. What IS testable live, and is the property that matters, is
# that the room is keyed by the account: an event published to a DIFFERENT account's channel must
# reach this socket not at all. It travels through the real Redis and the real gateway.
sleep 12
OTHER='{"kind":"conversation.created","accountId":"acc-nobody","conversationId":"conv-nobody"}'
docker compose exec -T redis redis-cli publish "crm:rt:acct:acc-nobody" "$OTHER" >/dev/null \
  && pass "an event for another account was published (the negative below is not vacuous)" \
  || fail "publishing to another account's channel" "redis-cli refused"

# The conversation the mail produced, for the assertions on the frames.
CONV=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  CONV=$(psql chats_db "select conversation_id from \"Message\" where external_id='$MSGID'")
  [ -n "$CONV" ] && break
  sleep 1
done
[ -n "$CONV" ] && pass "the mail became a ticket (W3's path, still working)" \
  || fail "the mail became a ticket" "no message with that Message-ID after 10s"

wait $CAP_PID

# ── what the sockets actually saw ────────────────────────────────────────────────────────────────
AUTHED_FRAMES=$(grep -c '"who":"authed","ev":"frame"' "$CAP" || true)
ANON_CLOSE=$(sed -n 's/.*"who":"anon","ev":"close","code":\([0-9]*\).*/\1/p' "$CAP" | head -1)
AUTHED_CLOSE=$(sed -n 's/.*"who":"authed","ev":"close","code":\([0-9]*\).*/\1/p' "$CAP" | head -1)

# ⭐ The positive control FIRST: every assertion below about what is ABSENT is satisfied by a capture
# that recorded nothing at all, which is the vacuous shape this project has hit seven times.
[ "$AUTHED_FRAMES" -ge 1 ] && pass "⭐ THE SOCKET RECEIVED EVENTS ($AUTHED_FRAMES frames)" \
  || fail "⭐ THE SOCKET RECEIVED EVENTS" "0 frames — capture: $(head -c 300 "$CAP")"

grep -q "\"conversationId\\\\\":\\\\\"$CONV" "$CAP" || grep -q "$CONV" "$CAP" \
  && pass "⭐ A TICKET THAT ARRIVED BY ITSELF ANNOUNCED ITSELF (conversation.created)" \
  || fail "⭐ the ticket announced itself" "no frame names $CONV"

grep -q 'message.created' "$CAP" \
  && pass "⭐ and so did its message (message.created)" \
  || fail "⭐ the message announced itself" "no message.created frame"

# ── the socket without a cookie ──────────────────────────────────────────────────────────────────
[ "$ANON_CLOSE" = "1008" ] && pass "⭐ A SOCKET WITH NO COOKIE IS CLOSED (1008), not left open and silent" \
  || fail "⭐ a socket with no cookie is closed" "close code=${ANON_CLOSE:-none}"
[ -z "$AUTHED_CLOSE" ] || [ "$AUTHED_CLOSE" = "1000" ] \
  && pass "…while the authorized one stayed open for the whole round" \
  || fail "the authorized socket stayed open" "closed with ${AUTHED_CLOSE}"
ANON_FRAMES=$(grep -c '"who":"anon","ev":"frame"' "$CAP" || true)
[ "$ANON_FRAMES" = "0" ] && pass "and it received nothing at all" \
  || fail "the unauthorized socket received nothing" "frames=$ANON_FRAMES"

# ── tenant isolation, live ───────────────────────────────────────────────────────────────────────
grep -q 'acc-nobody\|conv-nobody' "$CAP" \
  && fail "⭐⭐ ANOTHER ACCOUNT'S EVENT DID NOT ARRIVE" "the frame for acc-nobody reached this socket" \
  || pass "⭐⭐ ANOTHER ACCOUNT'S EVENT DID NOT ARRIVE (rooms are keyed by the account)"
echo "NOTE  a second REAL account cannot be tested here: this stand holds exactly one ($ACC)."
echo "NOTE  the two-sockets-two-accounts case is covered by ws/realtime.gateway.spec.ts, not live."

# ── nothing of the customer's rode the wire (FR-001) ─────────────────────────────────────────────
LEAK=$(grep -cE "$SUBJ|$CUSTOMER|ничего не нажимаю|Живое обновление" "$CAP" || true)
[ "$LEAK" = "0" ] && pass "⭐ NO FRAME CARRIES THE SUBJECT, THE ADDRESS OR THE BODY" \
  || fail "⭐ no frame carries the subject, the address or the body" "hits=$LEAK"

# ⓘ Asserted on the frames a browser received AND on the logs, because they fail independently: the
# payload can be clean while a publisher logs the event it just sent.
LOGLEAK=$(docker compose logs --no-log-prefix --since 5m chats gateway worker 2>/dev/null \
  | grep -cE "$CUSTOMER|ничего не нажимаю" || true)
[ "$LOGLEAK" = "0" ] && pass "⭐ NO LOG LINE CARRIES THE ADDRESS OR THE BODY" \
  || fail "⭐ no log line carries the address or the body" "hits=$LOGLEAK"

echo
echo "W4 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
