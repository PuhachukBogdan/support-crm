#!/usr/bin/env bash
# Run the W17 browser check against the stand's PUBLIC origin — the VIP tab as an AM uses it.
#
# ⚠️ Run it ON THE STAND (`ssh beton-test`), from the repository root, AND AFTER `live-w17.sh`:
# the live round builds the AM's portfolio through the product and leaves it attached — this check
# reads that state. Credentials come from `/tmp/probe.pw`; no owner login is needed here.
#
# ⓘ Sibling of `run-w16-browser-check.sh` — same harness, next screen. `lib/` MUST be copied
# alongside (files are copied into /tmp/pw-work one by one).
set -euo pipefail
EDGE_PW=$(tr -d '\r\n' < /tmp/probe.pw)
cp "$(dirname "$0")/w17-browser-check.mjs" /tmp/pw-work/w17-browser-check.mjs
mkdir -p /tmp/pw-work/lib && cp "$(dirname "$0")"/lib/*.mjs /tmp/pw-work/lib/
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-beton.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.1:8025 \
  -e EDGE_USER=probe -e EDGE_PASSWORD="$EDGE_PW" \
  -e ROLE_PASSWORD='Stand#Role7x' \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w17-browser-check.mjs
