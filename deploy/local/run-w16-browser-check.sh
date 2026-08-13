#!/usr/bin/env bash
# Run the W16 browser check against the stand's PUBLIC origin — the tag registry and the audit log.
#
# ⚠️ Run it ON THE STAND (`ssh beton-test`), from the repository root. Credentials are read from
# files on the host and never appear on a command line: `/tmp/probe.pw` (edge), `/tmp/owner.pw`.
#
# ⓘ Sibling of `run-w15a-browser-check.sh` — same harness, next screens. `lib/` MUST be copied
# alongside (files are copied into /tmp/pw-work one by one).
set -euo pipefail
EDGE_PW=$(tr -d '\r\n' < /tmp/probe.pw)
OWNER_PW=$(tr -d '\r\n' < /tmp/owner.pw)
cp "$(dirname "$0")/w16-browser-check.mjs" /tmp/pw-work/w16-browser-check.mjs
mkdir -p /tmp/pw-work/lib && cp "$(dirname "$0")"/lib/*.mjs /tmp/pw-work/lib/
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-beton.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.1:8025 \
  -e EDGE_USER=probe -e EDGE_PASSWORD="$EDGE_PW" \
  -e OWNER_EMAIL="${OWNER_EMAIL:-mistydubteck@beton.win}" \
  -e OWNER_PASSWORD="$OWNER_PW" \
  -e ROLE_PASSWORD='Stand#Role7x' \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w16-browser-check.mjs
