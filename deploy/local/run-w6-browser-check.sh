#!/usr/bin/env bash
# Run the W6 browser check against the stand's PUBLIC origin — the R38 Inbox as an agent sees it.
#
# ⚠️ Run it ON THE STAND (`ssh beton-test`), from the repository root. Credentials are read from files
# on the host and never appear on a command line. `/tmp/probe.pw` holds the edge basic-auth password
# for the `probe` user; `/tmp/pw-work` is a scratch directory with `playwright` installed (the
# mcr image carries the browsers, not the package).
#
# ⓘ Sibling of `live-w5.sh`, and deliberately a different kind of check: that one proves the WIRE,
# this one proves the SCREEN. Both are needed — the vault's `the-harness-avoided-what-was-broken`
# records what happens when only one of them exists.
set -euo pipefail
EDGE_PW=$(tr -d '\r\n' < /tmp/probe.pw)
cp "$(dirname "$0")/w6-browser-check.mjs" /tmp/pw-work/w6-browser-check.mjs
docker run --rm --network host -v /tmp:/tmp -w /tmp/pw-work \
  -e WEB_ORIGIN=https://crm-beton.37.1.206.146.sslip.io \
  -e MAIL_ORIGIN=http://127.0.0.1:8025 \
  -e EDGE_USER=probe -e EDGE_PASSWORD="$EDGE_PW" \
  -e PROBE_EMAIL="${PROBE_EMAIL:-seed-agent2@example.test}" \
  -e PROBE_PASSWORD='Stand#Seed7x' \
  -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
  mcr.microsoft.com/playwright:v1.50.0-noble node /tmp/pw-work/w6-browser-check.mjs
