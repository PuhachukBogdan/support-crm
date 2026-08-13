#!/usr/bin/env bash
# Run the W35 check (player notes) against the VERIFICATION stand — rule 12: the public link is frozen.
#
# ⚠️ Run it ON THE STAND (`ssh beton-test`), from `~/crm-next`. `lib/` MUST be copied alongside the
# check itself: the runner copies file-by-file into /tmp/pw-work, and a missing `lib/` fails only here.
#
# ⚠️ **The ADMINISTRATOR of this run is the OWNER account, not `admin@example.test`.** That credential is
# reset to a PLACEHOLDER by every `seed:auth`, and on this stand it currently is one — the login answers
# 401 `invalid_credentials`, which is what the first attempt at this run found. The owner is a
# `super_admin`, i.e. the same administrative clearance the tier policy derives from (`masked_pii`), so
# the leg it serves — «an administrator reads notes with no attachment» — is the same assertion.
#
# ⚠️ If every login answers **403** before a password is even judged, the stand has banned its own
# address: W32's check bans the caller's own address on purpose and the ban outlived its run. Lift it
# (`delete from "DeniedAddress" where address = '37.1.206.146';` in `auth_db`) — that is stand state, not
# a product defect, and the deny-list feature refusing before authentication is it working.
set -euo pipefail
# shellcheck disable=SC1091
source /tmp/probe-next.env
mkdir -p /tmp/pw-work/shots-w35 /tmp/pw-work/lib
HERE="$(cd "$(dirname "$0")" && pwd)"
cp "$HERE/w35-browser-check.mjs" /tmp/pw-work/w35-browser-check.mjs
cp "$HERE"/lib/*.mjs /tmp/pw-work/lib/
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-next.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.2:8025 \
  -e EDGE_USER="$PROBE_NEXT_USER" -e EDGE_PASSWORD="$PROBE_NEXT_PASSWORD" \
  -e ROLE_PASSWORD='Stand#Role7x' \
  -e ADMIN_EMAIL='warden@beton.win' \
  -e ADMIN_PASSWORD='Stand#Owner9x' \
  -e SHOT_DIR=/tmp/pw-work/shots-w35 \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w35-browser-check.mjs
