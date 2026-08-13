#!/usr/bin/env bash
# MVP block W1 — live round. Two claims, neither provable on the dev box:
#   1.9  a SEEDED person can sign in (password from the seed + the emailed code)
#   1.10 a freshly INVITED person is assignable — invite → register → assign, the order that failed
set -u
G=http://127.0.0.1:3000
M=http://127.0.0.1:8025
SEED_PW='Stand#Seed7x'
NEW_PW='Joiner#7xQ'
OWNER=mistydubteck@beton.win
OWNER_PW='m13aP1LLB07vyh#7A'
ok=0; bad=0
say(){ printf "%-58s %s\n" "$1" "$2"; }
pass(){ ok=$((ok+1)); say "$1" "ok"; }
fail(){ bad=$((bad+1)); say "$1" "FAIL: $2"; }

code_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*code: \([A-Z0-9]\{6\}\)".*/\1/p' | head -1 | tr -d '\r'; }
msg_of(){ curl -s "$M/api/v1/search?query=to%3A$1&limit=1" | sed -n 's/.*"ID":"\([^"]*\)".*/\1/p' | head -1; }
body_of(){ curl -s "$M/api/v1/message/$1" | sed -n 's/.*"Text":"\(.*\)","HTML".*/\1/p' | head -1; }

# ── 1.9 — a seeded agent signs in ────────────────────────────────────────────────────────────────
SEED_EMAIL=seed-agent1@example.test
CH=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"$SEED_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
if [ -n "$CH" ]; then pass "1.9 seeded agent: password accepted (step 1)"; else
  fail "1.9 seeded agent: password accepted (step 1)" "no challenge"; fi
sleep 3
SC=$(code_of "$SEED_EMAIL")
if [ -n "$SC" ]; then pass "1.9 seeded agent: code delivered by mail"; else
  fail "1.9 seeded agent: code delivered by mail" "no code in mailbox"; fi
J1=$(mktemp)
curl -s -c "$J1" -X POST $G/auth/verify -H 'Content-Type: application/json' \
  -d "{\"challengeId\":\"$CH\",\"code\":\"$SC\"}" >/dev/null
if grep -q access "$J1"; then pass "1.9 ⭐ SEEDED PERSON HAS A SESSION"; else
  fail "1.9 ⭐ SEEDED PERSON HAS A SESSION" "no session cookie"; fi
ME=$(curl -s -b "$J1" $G/auth/me)
echo "$ME" | grep -q '"userId"' && pass "1.9 /auth/me answers for that session" \
  || fail "1.9 /auth/me answers for that session" "$ME"
# A wrong password must still be refused — the seed did not make login permissive.
BAD=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"definitely-not-it\"}")
echo "$BAD" | grep -q challengeId && fail "1.9 wrong password refused" "a challenge was issued" \
  || pass "1.9 wrong password still refused"

# ── owner session (needed to invite and to assign) ───────────────────────────────────────────────
OCH=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"$OWNER_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
sleep 3
OC=$(code_of "$OWNER")
JO=$(mktemp)
curl -s -c "$JO" -X POST $G/auth/verify -H 'Content-Type: application/json' \
  -d "{\"challengeId\":\"$OCH\",\"code\":\"$OC\"}" >/dev/null
grep -q access "$JO" && pass "owner session" || { fail "owner session" "no cookie"; }

# ── 1.10 — invite → register → assign ────────────────────────────────────────────────────────────
STAMP=$(date +%s)
NEW=w1-am-$STAMP@example.test
INV=$(curl -s -b "$JO" -X POST $G/auth/invites -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NEW\",\"role\":\"am\"}")
echo "$INV" | grep -qi 'invitation\|id' && pass "1.10 invite issued for role am" \
  || fail "1.10 invite issued for role am" "$INV"
sleep 3
MID=$(msg_of "$NEW")
TOKEN=$(body_of "$MID" | grep -oE 'token=[A-Za-z0-9_.:-]+' | head -1 | cut -d= -f2 | tr -d '\r')
[ -n "$TOKEN" ] && pass "1.10 invite link arrived by mail" || fail "1.10 invite link arrived by mail" "no token in body"

curl -s -X POST $G/auth/register/start -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"email\":\"$NEW\"}" >/dev/null
sleep 3
RC=$(code_of "$NEW")
[ -n "$RC" ] && pass "1.10 registration code delivered" || fail "1.10 registration code delivered" "none"
JN=$(mktemp)
REG=$(curl -s -c "$JN" -X POST $G/auth/register/complete -H 'Content-Type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"email\":\"$NEW\",\"code\":\"$RC\",\"password\":\"$NEW_PW\"}")
echo "$REG" | grep -q '"ok"' && pass "1.10 registration completed" || fail "1.10 registration completed" "$REG"

# The claim: the profile exists NOW, without anybody touching the database.
sleep 1
NEWID=$(docker compose exec -T postgres psql -U postgres -d auth_db -tAc \
  "select id from \"User\" where email='$NEW'" | tr -d '\r ')
PROF=$(docker compose exec -T postgres psql -U postgres -d users_db -tAc \
  "select count(*) from \"Operator\" where auth_user_id='$NEWID'" | tr -d '\r ')
if [ "$PROF" = "1" ]; then pass "1.10 ⭐ REGISTRATION CREATED AN OPERATOR PROFILE"; else
  fail "1.10 ⭐ REGISTRATION CREATED AN OPERATOR PROFILE" "rows=$PROF"; fi

# And the sequence that used to answer `no such manager`.
ASSIGN=$(curl -s -b "$JO" -X POST $G/players/seed-brand-0000-0000-000000000001/seed-player-linked-a/assignment \
  -H 'Content-Type: application/json' -d "{\"amAuthUserId\":\"$NEWID\"}")
echo "$ASSIGN" | grep -qiE '"changed":true|ASSIGNMENT_STATUS_OK|already' \
  && pass "1.10 ⭐ ASSIGNING A PLAYER TO THE FRESH AM SUCCEEDS" \
  || fail "1.10 ⭐ ASSIGNING A PLAYER TO THE FRESH AM SUCCEEDS" "$ASSIGN"

# Idempotence: signing in again must not mint a second profile.
CH2=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$NEW\",\"password\":\"$NEW_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
sleep 3
C2=$(code_of "$NEW")
curl -s -X POST $G/auth/verify -H 'Content-Type: application/json' \
  -d "{\"challengeId\":\"$CH2\",\"code\":\"$C2\"}" >/dev/null
PROF2=$(docker compose exec -T postgres psql -U postgres -d users_db -tAc \
  "select count(*) from \"Operator\" where auth_user_id='$NEWID'" | tr -d '\r ')
[ "$PROF2" = "1" ] && pass "1.10 a second login mints NO twin profile" \
  || fail "1.10 a second login mints NO twin profile" "rows=$PROF2"

# ── the repair path: a person who has no profile gets one on their next login ────────────────────
SEEDUID=$(docker compose exec -T postgres psql -U postgres -d auth_db -tAc \
  "select id from \"User\" where email='$SEED_EMAIL'" | tr -d '\r ')
docker compose exec -T postgres psql -U postgres -d users_db -tAc \
  "delete from \"Operator\" where auth_user_id='$SEEDUID'" >/dev/null
GONE=$(docker compose exec -T postgres psql -U postgres -d users_db -tAc \
  "select count(*) from \"Operator\" where auth_user_id='$SEEDUID'" | tr -d '\r ')
CH3=$(curl -s -X POST $G/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"$SEED_PW\"}" | sed -n 's/.*"challengeId":"\([^"]*\)".*/\1/p')
sleep 3
C3=$(code_of "$SEED_EMAIL")
curl -s -X POST $G/auth/verify -H 'Content-Type: application/json' \
  -d "{\"challengeId\":\"$CH3\",\"code\":\"$C3\"}" >/dev/null
REPAIRED=$(docker compose exec -T postgres psql -U postgres -d users_db -tAc \
  "select count(*) from \"Operator\" where auth_user_id='$SEEDUID'" | tr -d '\r ')
if [ "$GONE" = "0" ] && [ "$REPAIRED" = "1" ]; then
  pass "1.10 ⭐ REPAIR: a profileless person gets one by signing in"
else
  fail "1.10 ⭐ REPAIR: a profileless person gets one by signing in" "before=$GONE after=$REPAIRED"
fi

# ── no secret reached a log ──────────────────────────────────────────────────────────────────────
LEAK=$(docker compose logs --no-log-prefix --since 10m auth gateway users 2>/dev/null \
  | grep -cE "$SEED_PW|$NEW_PW|$OWNER_PW" || true)
[ "$LEAK" = "0" ] && pass "no password appears in any service log" \
  || fail "no password appears in any service log" "hits=$LEAK"

echo
echo "W1 live: $ok ok, $bad failed"
[ "$bad" = "0" ]
