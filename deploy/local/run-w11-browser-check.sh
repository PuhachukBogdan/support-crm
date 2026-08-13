#!/usr/bin/env bash
# Run the W7 browser check against the stand's PUBLIC origin — the ticket window as an agent uses it.
#
# ⚠️ Run it ON THE STAND (`ssh beton-test`), from the repository root. Credentials are read from files
# on the host and never appear on a command line (`/tmp/probe.pw`, `/tmp/pw-work` as for W6).
#
# ⓘ Sibling of `run-w6-browser-check.sh` — same harness, next screen. The anti-storm assertion is
# imported from lib/, which MUST be copied alongside (files are copied into /tmp/pw-work one by one).
set -euo pipefail
EDGE_PW=$(tr -d '\r\n' < /tmp/probe.pw)
cp "$(dirname "$0")/w11-browser-check.mjs" /tmp/pw-work/w11-browser-check.mjs
mkdir -p /tmp/pw-work/lib && cp "$(dirname "$0")"/lib/*.mjs /tmp/pw-work/lib/
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-beton.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.1:8025 \
  -e EDGE_USER=probe -e EDGE_PASSWORD="$EDGE_PW" \
  -e PROBE_EMAIL="${PROBE_EMAIL:-role-teamlead@beton.win}" \
  -e PROBE_PASSWORD='Stand#Role7x' \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w11-browser-check.mjs
