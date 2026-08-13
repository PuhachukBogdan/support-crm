import { createFetchPort, API_PREFIX } from './http-port';

/**
 * T004 [027] — the port must be able to express a POST with a JSON body.
 *
 * ── Why this test stubs a global when the port's own header argues against it ────────────────────
 * `http-port.ts` exists so that NOTHING ELSE has to touch `fetch`. This file is testing that one
 * adapter, so it is the single place where stubbing the global is not stubbing the thing under
 * test — it is stubbing the thing under test's only dependency. Every other suite injects the port.
 *
 * ── What it fails on before T005/T006 ───────────────────────────────────────────────────────────
 * `createFetchPort` hardcodes `method: 'GET'` and sends no body, so the two POST expectations fail
 * on the method and on the absence of a body. The GET expectations pass both before and after,
 * which is the point: widening the port must leave every existing call site untouched.
 */

type FetchArgs = [input: string, init: RequestInit];

const fetchMock = jest.fn();
const originalFetch = (globalThis as { fetch?: unknown }).fetch;

/** A minimal Response stand-in. jsdom ships no `fetch`, and only `.status`/`.json()` are read. */
function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = originalFetch;
});

function lastCall(): FetchArgs {
  const call = fetchMock.mock.calls.at(-1) as FetchArgs | undefined;
  if (!call) throw new Error('the port made no request');
  return call;
}

describe('HttpPort — a request carrying a method and a body', () => {
  it('sends POST with a JSON body and the JSON content type', async () => {
    const port = createFetchPort();
    await port({ path: '/auth/login', method: 'POST', body: { email: 'a@b.test', password: 'pw' } });

    const [url, init] = lastCall();
    expect(url).toBe(`${API_PREFIX}/auth/login`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.test', password: 'pw' }));
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('keeps the cookie policy the session depends on', async () => {
    // The session lives in cookies the page cannot read; a request that forgets to send them is
    // indistinguishable from an expired session, which is the hardest shape of this bug to see.
    const port = createFetchPort();
    await port({ path: '/auth/verify', method: 'POST', body: { challengeId: 'c', code: '1' } });

    expect(lastCall()[1].credentials).toBe('same-origin');
  });

  it('never puts the body in the URL', async () => {
    // FR-015 / Principle IV: a password or a one-time code in a URL is logged by every proxy in
    // the chain and by browser history. Asserted here as well as structurally, because this is the
    // layer that would actually do it.
    const port = createFetchPort();
    await port({ path: '/auth/login', method: 'POST', body: { password: 'hunter2' } });

    expect(lastCall()[0]).not.toContain('hunter2');
    expect(lastCall()[0]).not.toContain('?');
  });

  it('still defaults to GET, with no body and the query intact', async () => {
    // The default is what keeps every existing call site compiling and behaving unchanged. If this
    // fails, the widening became a refactor of the data layer, which this feature is not.
    const port = createFetchPort();
    await port({ path: '/conversations', query: { pageSize: '2' } });

    const [url, init] = lastCall();
    expect(url).toBe(`${API_PREFIX}/conversations?pageSize=2`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('W7: sends PATCH and PUT with a JSON body, and DELETE with none', async () => {
    // The ticket window is the first writing screen; the gateway's routes use all three verbs
    // (PATCH status, PUT assignee/label, DELETE label/assignee). Before W7 the union refused them
    // at compile time and the adapter never saw one.
    const port = createFetchPort();

    await port({ path: '/conversations/c1/status', method: 'PATCH', body: { status: 'open' } });
    expect(lastCall()[1].method).toBe('PATCH');
    expect(lastCall()[1].body).toBe(JSON.stringify({ status: 'open' }));

    await port({ path: '/conversations/c1/assignee', method: 'PUT', body: { operatorId: 'op1' } });
    expect(lastCall()[1].method).toBe('PUT');

    await port({ path: '/conversations/c1/labels/l1', method: 'DELETE' });
    expect(lastCall()[1].method).toBe('DELETE');
    expect(lastCall()[1].body).toBeUndefined();
  });

  it('W7: passes a FormData through untouched, with no hand-set content type', async () => {
    // Multipart is the browser's job: it writes `multipart/form-data; boundary=…` only when the
    // header is ABSENT. JSON-serialising a FormData (or setting the header) produces a body the
    // gateway cannot parse — a failure visible only against the real server, which is exactly the
    // class of defect this port exists to keep out of every other file.
    const port = createFetchPort();
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.png');
    await port({ path: '/uploads/message_attachment', method: 'POST', body: form });

    const [, init] = lastCall();
    expect(init.body).toBe(form);
    expect(new Headers(init.headers).get('content-type')).toBeNull();
    expect(new Headers(init.headers).get('Accept')).toBe('application/json');
  });

  it('reports a refused connection as status 0 rather than throwing', async () => {
    // Unchanged behaviour, asserted because the POST path is a second way into the same catch.
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED http://gateway/auth/login'));
    const port = createFetchPort();

    await expect(port({ path: '/auth/login', method: 'POST', body: {} })).resolves.toEqual({
      status: 0,
      body: undefined,
    });
  });
});
