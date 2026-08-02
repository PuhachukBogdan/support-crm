import type { DataAccess } from '../data-access';
import type { Query } from '../types';
import { MockDataAccess } from '../mock/mock-data-access';
import { GatewayDataAccess } from '../gateway/gateway-data-access';
import { fixturePort, loadFixture, type RecordedResponse } from '../gateway/fixture-port';

/**
 * The subjects of the DataAccess conformance contract (feature 019, data-model §5).
 *
 * ── Why a subject rather than "run the same test twice" ─────────────────────────────────────────
 * The two implementations do not know the same resources — the mock serves an invented one, the
 * gateway serves `conversations` — so the expectations cannot be written against a fixed resource
 * name. They are written against BEHAVIOUR (paging advances, exhaustion terminates, empty is not an
 * error, an undeclared parameter is refused), which is resource-independent, and each subject says
 * how to reach that behaviour in its own terms.
 *
 * The pay-off is that "the mock and the real transport agree" becomes a test result instead of a
 * hope. It replaces `data-access.contract.test.ts`, which was named for the contract and constructed
 * `MockDataAccess` directly — a test of the mock.
 *
 * ── The gateway subject replays REAL pages ──────────────────────────────────────────────────────
 * `conversations-page{1,2,3}` were recorded from three consecutive requests to the live gateway.
 * Synthesising page 2 by editing page 1's token would have turned "pages do not overlap" into a test
 * of that edit.
 */

/** Scenarios an expectation can ask a subject for. Every subject must support all of them. */
export type Scenario =
  | 'paging' // at least three pages, the last one exhausted
  | 'empty' // a page with no items and no cursor
  | 'missing'; // a `get` for something that is not there

export interface Subject {
  readonly name: string;
  readonly resource: string;
  /** A valid base query, including any filter the resource requires. */
  baseQuery(limit: number): Query;
  create(scenario: Scenario): DataAccess;
  /** A filter key this resource does not declare — for the undeclared-parameter expectation. */
  readonly undeclaredFilterKey: string;
  /** Page size the paging scenario is built around. */
  readonly pageSize: number;
  /**
   * Write operations this implementation actually performs.
   *
   * The contract does NOT require every implementation to support writes — the mock is a demo store
   * and does, the gateway has no page needing them yet and does not. What it requires is that the
   * answer is one of two things and never a third: the operation takes effect, or it refuses by
   * name. A silent no-op — the third possibility — is what lets a screen believe it saved something.
   */
  readonly writes: readonly ('create' | 'update' | 'remove')[];
}

const CONV_PAGES: RecordedResponse[] = [
  loadFixture('conversations-page1'),
  loadFixture('conversations-page2'),
  loadFixture('conversations-page3'),
];
const CONV_MISSING = loadFixture('conversation-get-missing');

const mockSubject: Subject = {
  name: 'mock',
  resource: 'records',
  pageSize: 2,
  undeclaredFilterKey: 'thisFilterDoesNotExist',
  writes: ['create', 'update', 'remove'],
  baseQuery: (limit) => ({ limit }),
  create(scenario) {
    // 5 records at pageSize 2 → three pages, the last one short: the same shape the recorded
    // gateway traversal has, so both subjects exercise the same boundary.
    if (scenario === 'empty') return new MockDataAccess({ count: 0 });
    if (scenario === 'missing') return new MockDataAccess({ count: 1 });
    return new MockDataAccess({ count: 5 });
  },
};

const gatewaySubject: Subject = {
  name: 'gateway',
  resource: 'conversations',
  pageSize: 2,
  undeclaredFilterKey: 'thisFilterDoesNotExist',
  writes: [], // no page needs them yet; they must refuse by name until one does
  baseQuery: (limit) => ({ limit }),
  create(scenario) {
    if (scenario === 'empty') {
      const exhausted = { ...CONV_PAGES[2]!, body: { conversations: [], nextPageToken: '' } };
      return new GatewayDataAccess(fixturePort([exhausted]).port);
    }
    if (scenario === 'missing') return new GatewayDataAccess(fixturePort([CONV_MISSING]).port);
    return new GatewayDataAccess(fixturePort(CONV_PAGES).port);
  },
};

export const SUBJECTS: readonly Subject[] = [mockSubject, gatewaySubject];

/**
 * T009 [027] — the POST side of the transport, driven by the SAME recorded-response mechanism.
 *
 * ── Why these are listed here and not written inline in a session test ──────────────────────────
 * The reads got recordings for a reason (`../gateway/fixtures/README.md`): a hand-written body
 * verifies that the transport agrees with somebody's belief about the API. The auth calls are the
 * last place that should be exempt from that, because their bodies are the ones a screen makes a
 * security decision on.
 *
 * The success responses needed a real credential and a real emailed code, so they come from the same
 * script's live round-trip rather than from anybody's idea of what the API returns.
 *
 * ⭐ `auth-me-unauthenticated` is the one that earns the whole list: it is the only auth route whose
 * refusal body has a DIFFERENT SHAPE (Nest's `{message, statusCode}` rather than `{status}`),
 * because it is refused by the global guard rather than by the controller. The session therefore
 * reads the status and never the body.
 */
export interface AuthRecording {
  name: string;
  path: string;
  method: 'GET' | 'POST';
  /** Refusals must carry nothing; successes are checked field by field where they carry something. */
  refusal: boolean;
}

export const AUTH_RECORDINGS: readonly AuthRecording[] = [
  { name: 'auth-login-invalid', path: '/auth/login', method: 'POST', refusal: true },
  { name: 'auth-verify-invalid', path: '/auth/verify', method: 'POST', refusal: true },
  { name: 'auth-register-start-invalid', path: '/auth/register/start', method: 'POST', refusal: true },
  { name: 'auth-refresh-unauthorized', path: '/auth/refresh', method: 'POST', refusal: true },
  { name: 'auth-me-unauthenticated', path: '/auth/me', method: 'GET', refusal: true },
  { name: 'auth-login-code-sent', path: '/auth/login', method: 'POST', refusal: false },
  { name: 'auth-verify-ok', path: '/auth/verify', method: 'POST', refusal: false },
];

/** The id used by the "missing" expectation. Neither subject has a record under it. */
export const ABSENT_ID = 'no-such-record-019';
