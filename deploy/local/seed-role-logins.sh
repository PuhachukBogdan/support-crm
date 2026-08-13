#!/usr/bin/env bash
# One real login per operational role on the stand (roadmap: unblocks every future live round).
#
# Everything comes from what ARRIVED by email — codes and invite tokens are read out of the delivered
# message, never pasted. The seed puts a PLACEHOLDER hash in Credential.secret_hash, which is why no
# seeded user can log in and why this script exists.
# CRLF: SMTP bodies use \r\n, so anything grepped out of a message is stripped (tr -d "\r").
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
PW="Stand#Role7x"
OWNER=mistydubteck@beton.win
OWNER_PW="m13aP1LLB07vyh#7A"
J=$(mktemp)
ok=0; bad=0
say() { printf "%-46s %s\n" "$1" "$2"; }
pass() { ok=$((ok+1)); say "$1" "ok"; }
fail() { bad=$((bad+1)); say "$1" "FAIL: $2"; }

msg_id() { curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n "s/.*\"ID\":\"\([^\"]*\)\".*/\1/p" | head -1; }
code_of() { curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n "s/.*code: \([A-Z0-9]\{6\}\)\".*/\1/p" | head -1 | tr -d "\r"; }
body_of() { curl -s "$M/api/v1/message/$1" | sed -n "s/.*\"Text\":\"\(.*\)\",\"HTML\".*/\1/p" | head -1; }

# ── sign in as the owner (two-step, code out of the mailbox) ────────────────────────────────────
CH=$(curl -s -X POST $G/auth/login -H "Content-Type: application/json" \
  -d "{\"email\":\"$OWNER\",\"password\":\"$OWNER_PW\"}" | sed -n "s/.*\"challengeId\":\"\([^\"]*\)\".*/\1/p")
[ -n "$CH" ] || { echo "owner login step 1 failed"; exit 1; }
sleep 3
OC=$(code_of "$OWNER")
[ -n "$OC" ] || { echo "no owner code in the mailbox"; exit 1; }
curl -s -c "$J" -X POST $G/auth/verify -H "Content-Type: application/json" \
  -d "{\"challengeId\":\"$CH\",\"code\":\"$OC\"}" >/dev/null
grep -q access "$J" || { echo "owner verify produced no session"; exit 1; }
say "owner session" "ok"

for ROLE in support_agent vip_support am shift_am teamlead admin; do
  EMAIL="role-${ROLE//_/-}@beton.win"
  INV=$(curl -s -b "$J" -X POST $G/auth/invites -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"role\":\"$ROLE\"}" -w "|%{http_code}")
  case "$INV" in *"|200"*|*"|201"*) : ;; *) fail "$ROLE invite" "$INV"; continue ;; esac
  sleep 3
  ID=$(msg_id "$EMAIL"); TOK=$(body_of "$ID" | sed -n "s#.*register?token=\([A-Za-z0-9._%-]*\).*#\1#p" | head -1 | tr -d "\r")
  [ -n "$TOK" ] || { fail "$ROLE invite token" "not in the delivered message"; continue; }
  curl -s -X POST $G/auth/register/start -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOK\",\"email\":\"$EMAIL\"}" >/dev/null
  sleep 3
  RC=$(code_of "$EMAIL")
  [ -n "$RC" ] || { fail "$ROLE register code" "not delivered"; continue; }
  R=$(curl -s -X POST $G/auth/register/complete -H "Content-Type: application/json" \
    -d "{\"token\":\"$TOK\",\"email\":\"$EMAIL\",\"code\":\"$RC\",\"password\":\"$PW\"}" -w "|%{http_code}")
  case "$R" in *"|200"*) : ;; *) fail "$ROLE register/complete" "$R"; continue ;; esac
  # ⭐ POSITIVE CONTROL: the password must actually be accepted, not merely stored.
  L=$(curl -s -X POST $G/auth/login -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
  case "$L" in *challengeId*) pass "$ROLE -> $EMAIL" ;; *) fail "$ROLE login" "$L" ;; esac
done
echo "---- $ok ok / $bad failed ----"
