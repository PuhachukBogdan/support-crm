/**
 * T005 — the injected HTTP primitive (feature 019, data-model §2).
 *
 * ── Why this is injected rather than calling `fetch` directly ───────────────────────────────────
 * Two reasons, and the second is the one that matters.
 *
 * 1. jsdom provides no `fetch`, so a transport that reaches for a global is untestable without
 *    stubbing a global — which is a test that stubs the thing it is testing.
 * 2. It lets the conformance suite drive the transport from responses RECORDED off the live gateway
 *    instead of responses someone wrote by hand. A suite replaying invented bodies verifies that the
 *    transport agrees with an assumption; recording makes the fixture true by construction, and a
 *    server-side shape change becomes a visible diff instead of a silent divergence.
 *
 * ── The base is RELATIVE, on purpose ────────────────────────────────────────────────────────────
 * `/api` is proxied to the gateway by `next.config.mjs`, so every browser request is same-origin.
 * That is what makes `credentials: 'same-origin'` sufficient and what keeps the session cookie —
 * which page scripts cannot read by design — out of this file entirely. The transport never sees,
 * stores, or attaches a token.
 */

/** The prefix the browser talks to. Must match `API_PREFIX` in `next.config.mjs`. */
export const API_PREFIX = '/api';

export interface HttpRequest {
  /** Path below the prefix, e.g. `/conversations` or `/players/abc`. */
  path: string;
  /** Already-validated query parameters. The port does not decide what is allowed. */
  query?: Record<string, string>;
  /**
   * Defaults to `'GET'` — every call site written before feature 027 is unchanged by its absence.
   * The default is what keeps widening this port from being a refactor of the data layer.
   *
   * W7 adds `PATCH`/`PUT`/`DELETE`: the ticket window is the first screen that writes (status,
   * assignee, labels), and the gateway's routes use all three. Widened here once — the port stays
   * the only file that knows an HTTP verb exists.
   */
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /**
   * JSON-serialised by the adapter — unless it is a `FormData`, which is passed through untouched
   * (W7: `POST /uploads/:purpose` is multipart, the only byte-accepting route in the product).
   *
   * ⚠️ **Never encoded into `query`.** A password or a one-time code in a URL is written to every
   * proxy log between the browser and the service, and to the browser's own history (FR-015,
   * Principle IV). `no-query-secrets.test.ts` asserts no auth call passes a `query` at all.
   */
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON, or `undefined` when the body was absent or unparseable. */
  body: unknown;
  /**
   * True when the body could not be parsed as JSON. The CONTENT is deliberately not carried:
   * an unparseable body is frequently an HTML error page from something in front of the gateway,
   * and putting it anywhere it might be logged or shown is how a page leaks (SEC-26).
   */
  unparseable?: boolean;
}

/** The single primitive the transport depends on. */
export type HttpPort = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * The real adapter. A network failure is reported as status 0 rather than thrown, so the transport
 * has exactly one place that turns a status into a failure class — see `../errors.ts`.
 */
export function createFetchPort(prefix: string = API_PREFIX): HttpPort {
  return async ({ path, query, method = 'GET', body }: HttpRequest): Promise<HttpResponse> => {
    const qs = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : '';
    // The body is serialised into the REQUEST, never into the URL. Separated from the query
    // construction above by intent, not by accident: these are the two lines a future edit could
    // merge, and merging them is the one mistake this port must never make.
    const hasBody = body !== undefined;
    // A FormData travels as multipart and MUST NOT get a content-type here: the browser writes
    // `multipart/form-data; boundary=…` itself, and a hand-set header ships without the boundary —
    // the server then reads an unparseable body and the upload fails only against the real gateway.
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    let res: Response;
    try {
      res = await fetch(`${prefix}${path}${qs}`, {
        method,
        credentials: 'same-origin',
        headers:
          hasBody && !multipart
            ? { Accept: 'application/json', 'content-type': 'application/json' }
            : { Accept: 'application/json' },
        ...(hasBody ? { body: multipart ? (body as FormData) : JSON.stringify(body) } : {}),
      });
    } catch {
      // The reason is deliberately dropped: it can carry the full URL, and the caller only needs
      // "unavailable, retryable".
      return { status: 0, body: undefined };
    }

    try {
      return { status: res.status, body: await res.json() };
    } catch {
      return { status: res.status, body: undefined, unparseable: true };
    }
  };
}
