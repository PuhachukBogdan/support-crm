# `web/src/data` — the data layer

The boundary between screens and wherever data comes from. **Screens depend on the interface and never
on an implementation** — that is what makes swapping demo data for the real gateway one line instead of
a rewrite, and it is enforced by tests rather than by convention.

## The pieces

| File | What it is |
|---|---|
| `data-access.ts` | the five-method interface: `list` / `get` / `create` / `update` / `remove` |
| `types.ts` | `Query` (keyset — **no offset**), `PaginatedResult` (**no total**), `DataError`, `AsyncState` |
| `errors.ts` | failure classes and the sanitized error every failure becomes |
| `provider.tsx` | the swap point — `setDataAccess()` for sagas, `DataAccessProvider` for the React tree |
| `mock/` | `MockDataAccess` — invented records for frontend-only work |
| `gateway/` | `GatewayDataAccess` — the real transport over the gateway's REST edge |
| `conformance/` | one behavioural contract, executed against **every** implementation |

## Adding a resource: one row

Everything the transport knows about a resource lives in `gateway/registry.ts`. Adding one is adding a
row — path, the key its array arrives under, the query parameters it accepts, which are required, and
which operations exist:

```ts
{ resource: 'labels', path: '/labels', collection: 'labels',
  params: { conversationId: 'conversationId' }, required: [],
  pageSizeParam: 'pageSize', pageTokenParam: 'pageToken', ops: ['list'] }
```

**If a new resource seems to need an `if` in `gateway-data-access.ts`, the row shape is missing a
field — add the field, not the branch.** `registry.structure.test.ts` fails on any literal resource name
in the transport, so this is checked, not hoped for.

## Three rules that are not style preferences

**1. An undeclared parameter is refused before the request is built.** Two gateway routes disagree about
an unrecognised query parameter: `/players` refuses it with a 400, `/conversations` silently drops it.
Relying on the server means a stray filter is loud on one route and produces a *confident wrong answer*
on the other — the caller believes it filtered and receives everything. Both behaviours are recorded in
`gateway/fixtures/`.

**2. The transport invents nothing.** No defaulting, no normalising, no filling of missing fields. A
customer record arrives with only the fields the caller's role is cleared for — withheld ones are
**absent**, and a genuinely empty one is absent too, so the response never reveals *which* were withheld.
Re-adding a key client-side would undo that one layer up. **A surface decides what to render from the
caller's role, never from whether a value is empty.**

**3. Errors carry a class, never content.** No URL, no query value, no token, no record identifier, no
server text. The mechanism is that no code path exists from a response body to a message —
`no-leak.test.ts` checks it across every failure class.

## Tests, and why the fixtures are recorded

`conformance/` runs one set of behavioural expectations against both the mock and the real transport, so
a divergence in paging, empty-versus-error, or parameter handling fails immediately instead of surfacing
twenty screens later. It found seven on its first run — all in the mock, all real.

The transport's tests replay responses **recorded from the live gateway**
(`gateway/fixtures/`, written by `specs/019-gateway-transport/track-b.sh`). They live beside the tests
rather than beside the script because `specs/` is gitignored — a fixture kept there would be a test
dependency missing from every clean checkout. They are never
hand-authored: a hand-written body verifies that the transport agrees with someone's belief about the
API, which is not a property worth having. Re-record with the script; **never edit a fixture to make a
test pass** — the diff is the signal.

```bash
cd web && npx jest src/data      # the whole layer
```

## Not here yet

WebSocket/realtime, session refresh and 401 rotation (roadmap **8.6**, built by the first page that needs
it), write paths (added per resource by the page that needs them — until then they refuse by name), and
deriving a caller's permitted brands (roadmap **5.2**).

Canonical detail lives in `specs/019-gateway-transport/contracts/` — this file links to it and does not
copy it.
