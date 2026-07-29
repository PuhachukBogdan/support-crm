import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpPort, HttpRequest, HttpResponse } from './http-port';

/**
 * Test-only `HttpPort` that replays responses RECORDED from the live gateway
 * (`./fixtures/`, written by `specs/019-gateway-transport/track-b.sh` against the prepared test host).
 *
 * ── Why replay recordings instead of writing responses by hand ──────────────────────────────────
 * A hand-written body encodes what someone BELIEVED the API returns. Every test built on it then
 * verifies the transport against that belief, and agrees with it right up until a real browser
 * disagrees. This repository has four instances of that class already. A recording is true because
 * the server produced it — and when the server changes, the next recording differs, which is a diff
 * in a review rather than a silent divergence.
 *
 * It has already paid for itself once: the recorded pair `player-get-{admin,support}.json` is what
 * falsified the claim, made in two shipped documents, that withheld fields are absent from the
 * response. They are present and blank. See `contracts/gateway-rest.md`.
 */

/**
 * Beside the tests, deliberately. They started life under `specs/019-gateway-transport/` next to the
 * script that records them — and `specs/` is **gitignored**, so the suite depended on files no clean
 * checkout would have. Test data lives with the tests; the recording script writes here.
 */
const FIXTURE_DIR = join(__dirname, 'fixtures');

export interface RecordedResponse {
  status: number;
  path: string;
  body: unknown;
  unparseable?: boolean;
}

export function loadFixture(name: string): RecordedResponse {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as RecordedResponse;
}

/** Every recorded fixture, so a test can assert the corpus is not empty. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
}

export interface FixturePort {
  port: HttpPort;
  /** Every request the transport actually made — the evidence for "nothing was sent". */
  calls: HttpRequest[];
}

/**
 * Serve the given recordings, keyed by the name a test chooses. Requests are recorded so a test can
 * assert that a client-side refusal sent **nothing** — "it was refused" and "it was refused before
 * reaching the network" are different guarantees, and only the second one is the point of FR-004.
 */
export function fixturePort(responses: RecordedResponse[]): FixturePort {
  const calls: HttpRequest[] = [];
  let i = 0;
  const port: HttpPort = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    const rec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!rec) throw new Error('fixturePort: no recording left to serve');
    return { status: rec.status, body: rec.body, unparseable: rec.unparseable };
  };
  return { port, calls };
}
