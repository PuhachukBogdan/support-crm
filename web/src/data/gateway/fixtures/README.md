# Recorded gateway responses

**These files are RECORDED by `../track-b.sh` against the prepared test host. They are never
hand-authored, and never hand-edited to make a test pass.**

## Why they exist

The conformance suite and the transport's unit tests need real gateway responses without a running
server. If those responses were written by hand, the tests would verify that the transport agrees with
*someone's belief* about the API — which is not a property anyone needs. Recording inverts it: the
fixture is true because the server produced it.

This repository has already paid for the alternative four times (`gotchas/vacuous-pass-in-live-scripts`
in the wiki). The fourth was found on 2026-07-29 while planning this feature: a guard test that forbade
imports from a directory which had never existed, green since the day it was written.

## What is in them

One file per `route × role`, holding the status and the raw body exactly as returned — including
**refusals**. A recorded 403 is evidence, not a failed recording: User Story 2's whole point is that a
role below the masking boundary receives a *different* answer, and the refusal is part of that answer.

The bodies contain seeded synthetic records from `beton-test`. No real customer data exists anywhere in
this system (constitution Principle V), and recording is done **only** against the prepared test host —
never against a production target. That constraint outlives the security gate; it is in the script.

## The `auth-*` files (feature 027)

Recorded on 2026-08-02 off `crm-gateway-1` on `beton-test` while building feature 027, and
re-recorded by `specs/027-auth-flow-ui/track-b.sh` thereafter. They cover the **refusal** side of
the auth surface, which is the side reachable without a credential.

⭐ **`auth-me-unauthenticated.json` is the reason this set exists.** Every other auth route answers
`{"status": …}`; `GET /auth/me` refused by the global guard answers Nest's default
`{"message":"Unauthorized","statusCode":401}` — a **different body shape on the one route the
session polls most**. Nothing hand-written would have contained that, and any code that reads the
body to decide "am I signed in?" is wrong in a way no unit test built on an invented body could
show. The session reads the **status**, never the body, and this file is the evidence for why.

⚠️ The **success** responses (`code_sent`, `ok`) are recorded by the Track-B script, because they
require a real credential and a real emailed code. `codeExpiresAt` is **UNIX seconds** — from
`otp.service.ts` (`Math.floor(expiresAt.getTime() / 1000)`), carried over gRPC as a string and
`Number()`-ed at the gateway. `Date.now()` is milliseconds; comparing the two directly is how
FR-012's expired-versus-wrong distinction silently becomes "always" or "never".

## Refreshing them

```bash
bash deploy/local/prepare-test-server.sh     # first, always
bash specs/019-gateway-transport/track-b.sh  # records + verifies
```

If a consumed route changes shape, the diff in this directory **is** the report of what changed. That
diff is the value. Editing a fixture by hand to restore a green suite destroys exactly the signal the
recording exists to produce.
