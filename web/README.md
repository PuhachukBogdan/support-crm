# `web` — the front end

Next.js 15 (App Router, SSR) + React 19 + Tailwind + shadcn/ui, Redux Toolkit + Redux-Saga.
One workspace of the monorepo; it talks to **one** backend, the gateway, and to nothing else.

## Boundaries

| Concern | Where it lives | Screens see |
|---|---|---|
| Reading domain data | `src/data/` — `DataAccess`, the gateway transport, the route registry | `useDataAccess()` |
| Authentication | `src/session/` — the session boundary | `useSession()` |
| The network | `src/data/gateway/http-port.ts` — **the only file that calls `fetch`** | nothing |

Screens never see a URL, a cookie, a status code or a response body. Three structural tests keep it
that way rather than a convention: `src/data/no-direct-network.test.ts`,
`src/data/gateway/no-query-secrets.test.ts`, `src/session/no-local-session.test.ts`.

## The session (feature 027, roadmap 8.6)

The contract is [`specs/027-auth-flow-ui/contracts/session-port.md`](../specs/027-auth-flow-ui/contracts/session-port.md);
the types are in `src/session/session.ts`. Both are the source of truth — this file only says why.

**Four states, not two.** With an `httpOnly` cookie, *"am I signed in?"* is a question only the
server can answer, asked over a network that can fail. So the answer is `resolving` ·
`authenticated` · `anonymous` · **`unreachable`** — and the fourth is not "unknown", it is *"the
question could not be asked"*. Read it as signed out and one blip signs out the whole floor
mid-ticket; read it as signed in and a stranger sees protected chrome. The guard **holds** on it.

The union is exhaustive with no default: change its shape and `tsc` lists every consumer. That is
the mechanism, not a nicety — when it was introduced it enumerated a sign-out in `shell/topbar.tsx`
that neither the plan nor hand-reading had found.

**Resolved once per navigation, and shared.** `SessionProvider` asks; every consumer reads the same
context value. Not a cache — there is no stored answer to go stale.

**Seeded from the server.** `session-seed.ts` reads the cookie during SSR, because the server can see
it and the browser cannot. ⚠️ It never returns `authenticated`: a cookie's presence is a hint, an
expired cookie is still a cookie, and the gateway remains the only authority.

**The 401 → refresh → retry rotation lives in the transport** (`src/data/gateway/rotating-port.ts`),
not in the session and not in a screen. In the session it would cover only the session's own calls;
every other request would still die at the short access lifetime, and the symptom would be *"some
pages log me out"*. Exactly one attempt, and auth calls are excluded.

⚠️ **`codeExpiresAt` is UNIX seconds**, `Date.now()` is milliseconds. The expired-versus-wrong
distinction on the sign-in screen is one unit mistake away from being "always" or "never"; a
recorded fixture pins it.

## The sign-in screen's visuals are FROZEN

`app/(auth)/login/page.tsx` — the WebGL background, the dark backdrop, the radial-masked blur, the
card's entrance animation and the neutral wordmark are pinned **value by value** by
`frozen-visual.test.tsx`, by operator instruction. Behaviour may change; those values may not. If
that test fails, the fix is the code. It is pinned narrowly on purpose: a whole-page snapshot would
fail on every legitimate change to the form and would then be deleted, taking the guarantee with it.

## Running and testing

```bash
npm run dev --workspace web     # :3001, proxying /api → GATEWAY_ORIGIN (default :3000)
npm test --workspace web        # jest + Testing Library (jsdom)
npm run typecheck --workspace web
```

`next.config.mjs` rewrites `/api/*` to the gateway so every browser request is **same-origin** — the
gateway enables no CORS, and the alternative (a credentialed cross-origin allowlist) would be a
permanently reachable surface existing only for local development.

⚠️ jsdom has no `fetch`, which is why the transport is an injected port rather than a global. Tests
drive real implementations over a scripted or recorded port; they do not stub the session. A stub
always answers, and the states worth testing are the ones where nothing answers.

**Recorded fixtures.** `src/data/gateway/fixtures/` holds responses recorded off the live gateway by
the Track-B scripts — never hand-authored. See that directory's `README.md`.

## What Track A cannot prove

Live checks belong to `specs/027-auth-flow-ui/track-b.sh` on `beton-test`: that the cookie is really
`httpOnly`, that the code step is really unskippable, and that the rotation really fires when a real
access token really expires. A mocked transport passes all three whether or not they are true.

## The Inbox: R38's rail and toolbar (MVP block W6)

The screen's narrowing has three axes, and keeping them apart is the whole design:

| Axis | Control | State |
|---|---|---|
| **which state** | the rail — five buttons on status CATEGORIES (`buckets.ts`) | where you ARE |
| **which subset** | funnels in the column headers: status (from the catalogue, per bucket) · channel · priority | filters you APPLIED |
| **whose** | none — the screen IS the signed-in agent's (roadmap 5.11) | a SCOPE, not optional |

- ⭐⭐ **Buckets filter by `status_category`, NEVER by a status key.** Nine statuses collapse into five
  buttons by themselves; a status configured later lands in the right button with no code change. The
  previous rail spelled the retired key `resolved`, and every agent who clicked it got a 400 and a
  blank screen — categories are the closed six, so there is no account-specific word here left to rot.
  `buckets.test.tsx` re-proves the detector on planted input.
- **Status ▾ options come from `GET /conversations/statuses`**, narrowed to the current bucket's
  categories and to ACTIVE rows. A retired or renamed status is therefore unofferable while still
  rendering on old rows, and a key-vs-category contradiction is unbuildable by UI.
- ⭐⭐ **Self-scoped, with no control to widen it** (operator, 2026-08-06: *«Менеджеру и так только его
  тикеты приходят в инбокс и только его должны быть видны в open, solved, pending»*). Every request
  carries `assigneeOperatorId = mine`; until `/me/operator` answers there is **no request at all** and
  the screen shows its own loading, because "my tickets" silently meaning "all tickets" is both the
  confidently-wrong answer and a disclosure. ⓘ Consequence, stated: work assigned to NOBODY is visible
  to nobody here — the supervisor surface over that is 4.20/9.2a.
- ⚠️ **A funnel lives in its column, so it sheds with its column.** `channel` and `priority` are
  `contextual` tier: below ~1500 px they are dropped and their filters go too. That is the price of the
  header placement the operator asked for; the browser check runs at his own 1920 and says so.
- ⛔ **No numbers on the rail** (R38): counts are 9.2a's, the unread badge 9.12's. A number that is
  sometimes stale is worse than none.
- **Nothing is red.** R38 freed the colour for one meaning — a new customer message (9.12) — so `open`
  wears the neutral `foreground` token until that ships.
- ⓘ The transient-filter rule (FR-013) is unchanged: nothing is persisted, because anything named and
  kept is a *view* and views are granted by an admin. R38's "remember the channel chip per operator"
  is a server-side preference and rides W18's settings machinery rather than a second mechanism here.

### ⛔ The two libraries this table may not host

`DataTable` renders `ColumnDef`s **itself** — no TanStack Table row model, no virtualizer — and the
funnels are hand-written, not Radix. That is not preference: `table.getRowModel()` turned one click
into ~9 000 React scheduler posts per second and killed the tab with no JS error (the operator's freeze,
three times), and both a native `<select>` and Radix `Select` had frozen the same screen before. The
long note in `data-table.tsx` carries the probe-by-probe measurement; the vault gotcha carries the
method. ⇒ **Anything a render prop receives must be a stable reference** (an inline arrow is a new
component type per render), and **an element a long-lived observer watches must outlive the observer**.

**The screen check lives in `deploy/local/w6-browser-check.mjs`** and runs on the stand against the
PUBLIC origin — the rail, the catalogue-derived options, «Мои» narrowing, the column's names, no red.
⚠️ It documents a measured limit of its own container (real-input clicks wedge that Chromium at about
the sixth) rather than skipping around it; read its header before adding interactions.
