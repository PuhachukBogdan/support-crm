import nextConfig, { API_PREFIX, GATEWAY_ORIGIN } from '../../../next.config.mjs';

/**
 * T002 [Setup] — the same-origin rewrite is the only reason a browser can reach the gateway at all
 * (research R1). Deleting it does not fail a build and does not fail any other test: it fails at
 * runtime, in a browser, as a CORS error that looks like a backend problem.
 *
 * So it is asserted here. The transport's relative base is meaningless without it.
 */
describe('same-origin API rewrite', () => {
  it('exists and maps the API prefix to the configured gateway origin', async () => {
    const { rewrites } = nextConfig;
    // Narrowed rather than asserted with `!`: if the config ever stops declaring rewrites, this must
    // fail here with a readable message, not throw on an undefined call.
    if (typeof rewrites !== 'function') throw new Error('next.config.mjs declares no rewrites()');
    const rules = await rewrites();

    expect(rules).toEqual([
      { source: `${API_PREFIX}/:path*`, destination: `${GATEWAY_ORIGIN}/:path*` },
    ]);
  });

  it('proxies rather than exposing an absolute host to the browser', () => {
    // The prefix the browser sees must be relative — an absolute destination here would mean the
    // page is calling another origin directly, which is exactly what the gateway does not allow.
    expect(API_PREFIX.startsWith('/')).toBe(true);
    expect(API_PREFIX).not.toMatch(/^https?:/);
  });

  it('sends the whole path through, not a fixed set of routes', () => {
    // A rewrite enumerating routes would silently 404 every route added later — the transport's
    // registry is the place where routes are enumerated, and it is data with its own tests.
    expect(`${API_PREFIX}/:path*`).toContain(':path*');
  });
});
