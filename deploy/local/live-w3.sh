#!/usr/bin/env bash
# MVP block W3 — live round (roadmap 6.1/6.4/6.5/6.6, feature 033).
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
# The operator's acceptance criterion for the whole block, in his words:
#   «пишу в API и на почту → оба тикета появляются в системе сами»
#
# So this script writes to both, from OUTSIDE the product, and then reads the result out of the
# product's own surfaces. Everything here is a thing no unit test can answer:
#
#   2.1a  a signed webhook becomes a ticket · a FORGED one writes nothing
#   2.1a  the same delivery twice is one ticket (the constraint, not the code, is what refuses)
#   2.1c  an email becomes a ticket IN SECONDS via IMAP IDLE, carrying its own Subject
#   2.1c  the customer's reply lands in the SAME ticket (threading, over real MIME headers)
#   2.1d  the agent's reply is received by the customer — read back out of the mailbox
#   2.1e  the capability matrix answers over REST
#   the migration left NO conversation on an unresolvable channel value
#
# ⚠️ MUST PASS TWICE CONSECUTIVELY (SC-011). Every identifier is unique per run, and nothing is
# cleaned up by hand: a second run that fails because the first one left state behind is a defect in
# the product, not in the script.
# ═══════════════════════════════════════════════════════════════════════════════════════════════════
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025            # mailpit — login codes only (it speaks no IMAP, research R16)
GM_SMTP=127.0.0.1:3025             # greenmail SMTP: where the "customer" posts from
GM_IMAP=127.0.0.1:3143             # greenmail IMAP: the channel mailbox AND the customer's inbox
SEED_PW='Stand#Seed7x'
OWNER=mistydubteck@beton.win
OWNER_PW='m13aP1LLB07vyh#7A'
AGENT=seed-agent1@example.test
ACC=seed-account-0000-0000-000000000001
API_KEY=stand-api-brand1
MAIL_KEY=stand-email-brand1
SUPPORT=support-brand1@stand.test  # the channel's own address (CHANNEL_EMAIL_ADDRESS)
CUSTOMER=live-w3-player@stand.test # the "customer" — greenmail creates users on first login
API_SECRET="${CHANNEL_SECRETS##*:}" # the stand's shared secret, as `.env` spells it

RUN=$(date +%s)                    # unique per run, which is what makes a second run meaningful
ok=0; bad=0
say(){ printf "%-70s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }
# ⚠️ `tr -d '\r'`, NOT `tr -d '\r '`. The first draft deleted spaces too, which strips them from INSIDE a
# value: a subject of `Не приходит вывод 123` came back as `Неприходитвывод123` and the title assertion
# failed against a database that was perfectly correct. `psql -tA` does not pad its output, so there was
# never anything for the space-strip to trim — it could only ever do harm, and only to the assertions whose
# values contain spaces, which is why it passed everywhere else.
psql(){ docker compose exec -T postgres psql -U postgres -d "$1" -tAc "$2" | tr -d '\r'; }
code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }

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

# The signature the product verifies: HMAC-SHA256 over "<t>.<raw body>", hex, as `t=…,v1=…`.
# ⚠️ Computed over the EXACT bytes posted below. A re-serialisation here would fail every signature and
# look like the product rejecting valid deliveries — which is why the gateway preserves the raw body.
sign(){ # $1 raw body → prints the header value
  local t d
  t=$(date +%s)
  d=$(printf '%s.%s' "$t" "$1" | openssl dgst -sha256 -hmac "$API_SECRET" -hex | sed 's/.*= //')
  printf 't=%s,v1=%s' "$t" "$d"
}

# ── sessions ─────────────────────────────────────────────────────────────────────────────────────
JO=$(login "$OWNER" "$OWNER_PW"); grep -q access "$JO" && pass "owner session" || fail "owner session" "no cookie"
JA=$(login "$AGENT" "$SEED_PW");  grep -q access "$JA" && pass "agent session" || fail "agent session" "no cookie"

# ── the migration: no conversation carries a channel value nothing can resolve (research R15) ────
BADCH=$(psql chats_db "select count(*) from \"Conversation\" where channel is not null and channel not in ('api','email','messenger')")
[ "$BADCH" = "0" ] && pass "⭐ NO conversation carries an unresolvable channel value" \
  || fail "⭐ NO conversation carries an unresolvable channel value" "rows=$BADCH"
NULLCH=$(psql chats_db "select count(*) from \"Conversation\" where channel is null")
[ -n "$NULLCH" ] && pass "NULL is still reachable — an absence, not a fourth kind ($NULLCH rows)" \
  || fail "NULL is still reachable" "query failed"

# ── 2.1a — a signed delivery becomes a ticket ────────────────────────────────────────────────────
EVT="live-w3-api-$RUN"
BODY="{\"event_id\":\"$EVT\",\"message\":{\"text\":\"live w3 api $RUN\"},\"author\":{\"player_id\":\"p-777\"}}"
SIG=$(sign "$BODY")
HTTP=$(curl -s -o /tmp/w3api.json -w '%{http_code}' -X POST "$G/channels/$API_KEY/inbound" \
  -H 'Content-Type: application/json' -H "X-CRM-Signature: $SIG" -d "$BODY")
CONV_API=$(sed -n 's/.*"conversationId":"\([^"]*\)".*/\1/p' /tmp/w3api.json)
[ "$HTTP" = "202" ] && [ -n "$CONV_API" ] && pass "2.1a ⭐ a signed webhook becomes a ticket (202)" \
  || fail "2.1a ⭐ a signed webhook becomes a ticket" "http=$HTTP body=$(head -c 160 /tmp/w3api.json)"

MSGS=$(psql chats_db "select count(*) from \"Message\" where conversation_id='$CONV_API'")
[ "$MSGS" = "1" ] && pass "2.1a the customer's words are on it, once" \
  || fail "2.1a the customer's words are on it, once" "messages=$MSGS"

STATE=$(psql chats_db "select channel||'/'||coalesce(identity_state,'?') from \"Conversation\" where id='$CONV_API'")
[ "$STATE" = "api/unidentified" ] && pass "2.1a/2.1b the kind is typed and the identity state is STORED" \
  || fail "2.1a/2.1b the kind is typed and the identity state is STORED" "state=$STATE"

# ⭐ Idempotence over the real constraint. The provider retries when its acknowledgement is lost, so
# this is the NORMAL case rather than an attack.
HTTP2=$(curl -s -o /tmp/w3dup.json -w '%{http_code}' -X POST "$G/channels/$API_KEY/inbound" \
  -H 'Content-Type: application/json' -H "X-CRM-Signature: $(sign "$BODY")" -d "$BODY")
COUNT_API=$(psql chats_db "select count(*) from \"ChannelIntake\" where external_event_id='$EVT'")
[ "$HTTP2" = "200" ] && [ "$COUNT_API" = "1" ] \
  && pass "2.1a ⭐ the SAME delivery twice is ONE ticket, answered 200 (not an error)" \
  || fail "2.1a ⭐ the SAME delivery twice is ONE ticket" "http=$HTTP2 ledger=$COUNT_API"

# ── 2.1a — a forged signature writes NOTHING ─────────────────────────────────────────────────────
BEFORE_CONV=$(psql chats_db "select count(*) from \"Conversation\"")
FORGED="{\"event_id\":\"live-w3-forged-$RUN\",\"message\":{\"text\":\"forged\"}}"
HTTPF=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$G/channels/$API_KEY/inbound" \
  -H 'Content-Type: application/json' -H 'X-CRM-Signature: t=1,v1=deadbeef' -d "$FORGED")
AFTER_CONV=$(psql chats_db "select count(*) from \"Conversation\"")
[ "$HTTPF" = "401" ] && [ "$BEFORE_CONV" = "$AFTER_CONV" ] \
  && pass "2.1a ⭐ A FORGED SIGNATURE IS REFUSED AND WRITES NOTHING (401)" \
  || fail "2.1a ⭐ A FORGED SIGNATURE IS REFUSED AND WRITES NOTHING" "http=$HTTPF before=$BEFORE_CONV after=$AFTER_CONV"

UNKNOWN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$G/channels/no-such-key/inbound" \
  -H 'Content-Type: application/json' -H "X-CRM-Signature: $(sign '{}')" -d '{}')
[ "$UNKNOWN" = "404" ] && pass "2.1a an unknown key is 404 — indistinguishable from a disabled one" \
  || fail "2.1a an unknown key is 404" "http=$UNKNOWN"

# ── 2.1c — an email becomes a ticket, in SECONDS, via IDLE ───────────────────────────────────────
# ⚠️ Posted with curl over SMTP, from outside every service: this is a stranger's mail arriving, not a
# fixture inserted into a table.
MSGID="<live-w3-in-$RUN@stand.test>"
SUBJ="Не приходит вывод $RUN"
MAIL=$(mktemp)
{
  printf 'From: %s\r\n' "$CUSTOMER"
  printf 'To: %s\r\n' "$SUPPORT"
  printf 'Subject: %s\r\n' "$SUBJ"
  printf 'Message-ID: %s\r\n' "$MSGID"
  printf 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n'
  printf '\r\nтретий день не приходит вывод, помогите\r\n'
} > "$MAIL"
curl -s --url "smtp://$GM_SMTP" --mail-from "$CUSTOMER" --mail-rcpt "$SUPPORT" --upload-file "$MAIL" \
  && pass "2.1c the customer's mail was accepted by the mail server" \
  || fail "2.1c the customer's mail was accepted by the mail server" "smtp refused"

# ⭐ SC-002: within 5 seconds, because the mailbox TELLS us (IDLE) rather than being polled. The sweep
# interval is 60 s, so anything slower than ~10 s here means the push path is broken and the SAFETY NET
# is what found the message — which is exactly the failure this bound exists to expose.
CONV_MAIL=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  CONV_MAIL=$(psql chats_db "select conversation_id from \"Message\" where external_id='$MSGID'")
  [ -n "$CONV_MAIL" ] && break
  sleep 1
done
[ -n "$CONV_MAIL" ] && pass "2.1c ⭐ AN EMAIL BECAME A TICKET BY ITSELF, within 10s (IDLE, not a poll)" \
  || fail "2.1c ⭐ AN EMAIL BECAME A TICKET BY ITSELF" "no message with that Message-ID after 10s"

TITLE=$(psql chats_db "select subject||'/'||coalesce(subject_source,'?') from \"Conversation\" where id='$CONV_MAIL'")
[ "$TITLE" = "$SUBJ/source" ] && pass "2.1c the Subject header IS the title, marked source-given" \
  || fail "2.1c the Subject header IS the title, marked source-given" "title=$TITLE"

# ⚠️ The load-bearing negative of the feature: chats holds a HANDLE, users holds the address.
HANDLE=$(psql chats_db "select coalesce(channel_participant_id,'') from \"Conversation\" where id='$CONV_MAIL'")
ADDR_IN_USERS=$(psql users_db "select count(*) from \"ChannelParticipant\" where id='$HANDLE' and address='$CUSTOMER'")
[ -n "$HANDLE" ] && [ "$ADDR_IN_USERS" = "1" ] \
  && pass "2.1c ⭐ the address lives in users_db; chats holds only an opaque handle" \
  || fail "2.1c ⭐ the address lives in users_db; chats holds only a handle" "handle=$HANDLE inUsers=$ADDR_IN_USERS"

# ── 2.1d — the agent replies, and the CUSTOMER receives it ───────────────────────────────────────
# ⚠️ `reply`, not `PUBLIC_REPLY`. The REST vocabulary is `reply | note` and `toKindWire` maps it to the wire
# enum `MESSAGE_KIND_PUBLIC_REPLY` — the internal name this line used to send. That contract predates this
# block (the Inbox posts replies through it), so the 400 was the gateway being right.
POSTED=$(curl -s -o /tmp/w3reply.json -w '%{http_code}' -b "$JA" -X POST "$G/conversations/$CONV_MAIL/messages" \
  -H 'Content-Type: application/json' -d "{\"kind\":\"reply\",\"body\":\"проверяем, ответим в течение часа ($RUN)\"}")
[ "$POSTED" = "201" ] || [ "$POSTED" = "200" ] && pass "2.1d the agent's public reply is recorded" \
  || fail "2.1d the agent's public reply is recorded" "http=$POSTED"

INTENTS=$(psql chats_db "select count(*) from \"OutboundMessage\" o join \"Message\" m on m.id=o.message_id where m.conversation_id='$CONV_MAIL'")
[ "$INTENTS" -le 1 ] && pass "2.1d at most ONE delivery intent per reply (the unique constraint)" \
  || fail "2.1d at most ONE delivery intent per reply" "intents=$INTENTS"

# ⭐ Read the reply out of the CUSTOMER's mailbox. One mail server plays both sides; the addresses tell
# them apart. Waited for, because the sender is a 15 s tick rather than the request.
GOT=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
  GOT=$(curl -s --url "imap://$GM_IMAP/INBOX" --user "$CUSTOMER:stand" \
    -X "SEARCH SUBJECT \"$RUN\"" 2>/dev/null | tr -d '\r')
  case "$GOT" in *[0-9]*) break ;; esac
  sleep 2
done
case "$GOT" in
  *[0-9]*) pass "2.1d ⭐ THE CUSTOMER RECEIVED THE AGENT'S REPLY (read from their mailbox)" ;;
  *) fail "2.1d ⭐ THE CUSTOMER RECEIVED THE AGENT'S REPLY" "nothing in the customer's inbox after 50s" ;;
esac

LEFT=$(psql chats_db "select count(*) from \"OutboundMessage\" o join \"Message\" m on m.id=o.message_id where m.conversation_id='$CONV_MAIL'")
[ "$LEFT" = "0" ] && pass "2.1d the sent row is GONE — a queue, not a history" \
  || fail "2.1d the sent row is GONE" "rows=$LEFT (status: $(psql chats_db "select string_agg(status||':'||coalesce(last_error_class,'-'),',') from \"OutboundMessage\"") )"

OURID=$(psql chats_db "select coalesce(external_id,'') from \"Message\" where conversation_id='$CONV_MAIL' and author_type='operator' order by created_at desc limit 1")
[ -n "$OURID" ] && pass "2.1d our own Message-ID survived the row it was sent by (threading later works)" \
  || fail "2.1d our own Message-ID survived the row" "no external_id on the reply"

# ── 2.1c — the reply to that reply lands in the SAME ticket ──────────────────────────────────────
FOLLOW="<live-w3-follow-$RUN@stand.test>"
MAIL2=$(mktemp)
{
  printf 'From: %s\r\n' "$CUSTOMER"
  printf 'To: %s\r\n' "$SUPPORT"
  printf 'Subject: Re: %s\r\n' "$SUBJ"
  printf 'Message-ID: %s\r\n' "$FOLLOW"
  printf 'In-Reply-To: %s\r\n' "$OURID"
  printf 'References: %s %s\r\n' "$MSGID" "$OURID"
  printf 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n'
  printf '\r\nспасибо, жду\r\n'
} > "$MAIL2"
curl -s --url "smtp://$GM_SMTP" --mail-from "$CUSTOMER" --mail-rcpt "$SUPPORT" --upload-file "$MAIL2" >/dev/null

SAME=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  SAME=$(psql chats_db "select conversation_id from \"Message\" where external_id='$FOLLOW'")
  [ -n "$SAME" ] && break
  sleep 1
done
[ "$SAME" = "$CONV_MAIL" ] \
  && pass "2.1c ⭐ THE REPLY TO OUR REPLY LANDED IN THE SAME TICKET (no second ticket)" \
  || fail "2.1c ⭐ THE REPLY TO OUR REPLY LANDED IN THE SAME TICKET" "landed in '$SAME', expected '$CONV_MAIL'"

# ⚠️ Scoped to `channel='email'`, and this is a NARROWING of the predicate rather than of the claim. The run
# creates two legitimate tickets — one per channel — and the API one's subject is `live w3 api <RUN>`, so an
# unscoped `like '%RUN%'` counted it as a stray of the email exchange. It passed for weeks only because the
# email leg never produced a ticket at all: with one match it looked correct, and the one match was the
# WRONG ticket. The property asserted is unchanged: three emails in, exactly one email ticket.
STRAY=$(psql chats_db "select count(*) from \"Conversation\" where channel='email' and subject like '%$RUN%'")
[ "$STRAY" = "1" ] && pass "2.1c the whole exchange is ONE ticket, with 0 strays" \
  || fail "2.1c the whole exchange is ONE ticket" "email tickets matching this run=$STRAY"

# ── 2.1e — the capability matrix, over REST ──────────────────────────────────────────────────────
CAPS=$(curl -s -b "$JO" "$G/conversations/channel-capabilities")
echo "$CAPS" | grep -q 'CHANNEL_KIND_MESSENGER' && pass "2.1e the matrix answers for all three kinds" \
  || fail "2.1e the matrix answers for all three kinds" "$(echo "$CAPS" | head -c 160)"
echo "$CAPS" | grep -q '"outboundTransport"' && pass "2.1e ⭐ both transport directions travel (api: in, not out)" \
  || fail "2.1e ⭐ both transport directions travel" "$(echo "$CAPS" | head -c 200)"

# ── nothing leaked (FR-044/FR-047) ──────────────────────────────────────────────────────────────
# ⚠️ The customer's ADDRESS, the SUBJECT, the BODY and the channel SECRET. This is the assertion the
# whole feature's Principle IV work exists for, and the only place it can be made against real logs.
LEAK=$(docker compose logs --no-log-prefix --since 10m chats gateway worker users 2>/dev/null \
  | grep -cE "$CUSTOMER|$API_SECRET|не приходит вывод|спасибо, жду" || true)
[ "$LEAK" = "0" ] && pass "⭐ NO log line carries the address, the subject, the body or the secret" \
  || fail "⭐ NO log line carries the address, the subject, the body or the secret" "hits=$LEAK"

echo
echo "W3 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
