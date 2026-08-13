#!/usr/bin/env bash
# Run the W36 check (password recovery and change) against the VERIFICATION stand — rule 12.
#
# ⚠️ It CHANGES a stand password on purpose: that is the feature. It puts it back at the end, and prints
# both values, so a failed run mid-way leaves a trail rather than a mystery.
#
# ⚠️ If every login answers 403 before the password is judged, the stand has banned its own address
# (W32's check does it deliberately and the ban outlives the run):
#   delete from "DeniedAddress" where address = '37.1.206.146';   -- in auth_db
# ⚠️⚠️ **THE RATE LIMIT MAKES THIS ROUND NON-REPEATABLE UNLESS auth IS RESTARTED FIRST**, and that is the
# product being right rather than a nuisance: recovery is capped at RECOVERY_RATE_MAX (3) per address per
# hour, so the fourth run in an hour answers 202 and queues NO mail — after which the check reads the
# PREVIOUS run's link, which the new request has already voided, and every downstream assertion fails with
# «expired» against a perfectly healthy feature. Three runs were spent discovering that.
#
# The limiter is in-memory and per-process, so restarting the service is what clears it. Restarting is
# preferable to raising the cap on the stand: a check that runs against a weakened limit is not checking
# the product that ships.
set -euo pipefail
# shellcheck disable=SC1091
source /tmp/probe-next.env
( cd "$(dirname "$0")/../.." && COMPOSE_PROJECT_NAME=crm-next COMPOSE_FILE=compose.yaml:compose.next.yaml     docker compose restart auth >/dev/null 2>&1 ) && sleep 8
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /tmp/pw-work/shots-w36 /tmp/pw-work/lib
cp "$HERE/w36-browser-check.mjs" /tmp/pw-work/w36-browser-check.mjs
cp "$HERE"/lib/*.mjs /tmp/pw-work/lib/
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-next.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.2:8025 \
  -e EDGE_USER="$PROBE_NEXT_USER" -e EDGE_PASSWORD="$PROBE_NEXT_PASSWORD" \
  -e SUBJECT_EMAIL='role-shift-am@beton.win' \
  -e SUBJECT_PASSWORD='Stand#Role7x' \
  -e OWNER_EMAIL='warden@beton.win' \
  -e OWNER_PASSWORD='Stand#Owner9x' \
  -e SHOT_DIR=/tmp/pw-work/shots-w36 \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w36-browser-check.mjs
