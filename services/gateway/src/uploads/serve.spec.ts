import { buildUploadHeaders } from './serve';

/**
 * T043 (feature 016, US2) — a stored file is DATA, never an active document (FR-012 / research R7).
 *
 * These headers are the second layer of the polyglot defence. The first is the re-encode, which
 * removes an appended payload from the derivative by construction; this layer covers the ORIGINAL,
 * which is served as-uploaded. It depends on the client obeying, which is exactly why it is not the
 * only layer — and why it lives in ONE function, so a future route cannot serve bytes with a
 * different posture.
 */
const png = { contentType: 'image/png', displayName: 'shot.png', inlineSafe: true };
const pdf = { contentType: 'application/pdf', displayName: 'receipt.pdf', inlineSafe: false };

describe('the type served is the VERIFIED one, and the client is told not to re-decide it', () => {
  it('Content-Type is passed through unchanged', () => {
    expect(buildUploadHeaders({ ...png, isDerivative: false })['Content-Type']).toBe('image/png');
  });

  it('*** X-Content-Type-Options: nosniff ***', () => {
    // Without it the browser may re-decide the type and defeat the server-side allow-list entirely.
    for (const v of [png, pdf]) {
      expect(buildUploadHeaders({ ...v, isDerivative: false })['X-Content-Type-Options']).toBe(
        'nosniff',
      );
    }
  });

  it('*** a per-response sandbox CSP ***', () => {
    // An extra layer under the app-wide CSP (SEC-12), scoped to the one response that carries
    // untrusted bytes. `default-src 'none'` means even a document that renders can fetch nothing.
    const csp = buildUploadHeaders({ ...png, isDerivative: false })['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
  });
});

describe('disposition follows what the format can DO, not what it is called', () => {
  it('a raster image is inline', () => {
    const d = buildUploadHeaders({ ...png, isDerivative: false })['Content-Disposition']!;
    expect(d.startsWith('inline')).toBe(true);
  });

  it('*** a PDF is an attachment ***', () => {
    // A PDF renders in-browser as an active document with its own scripting; an image does not.
    const d = buildUploadHeaders({ ...pdf, isDerivative: false })['Content-Disposition']!;
    expect(d.startsWith('attachment')).toBe(true);
  });

  it('the filename in the header is sanitized, and cannot forge a second header', () => {
    const nasty = buildUploadHeaders({
      contentType: 'image/png',
      displayName: 'a";x\r\nX-Evil: 1',
      inlineSafe: true,
      isDerivative: false,
    })['Content-Disposition']!;
    expect(nasty).not.toContain('\r');
    expect(nasty).not.toContain('\n');
    // A stray quote would close the quoted-string and let the rest be read as header syntax.
    expect(nasty.match(/"/g)?.length).toBe(2);
  });

  it('a missing display name omits the filename rather than inventing one', () => {
    const d = buildUploadHeaders({
      contentType: 'image/png',
      displayName: '',
      inlineSafe: true,
      isDerivative: false,
    })['Content-Disposition']!;
    expect(d).toBe('inline');
  });
});

describe('*** caching differs by variant, and that difference is the point *** (Principle VII)', () => {
  it('a derivative is privately cacheable for five minutes', () => {
    // The Principle-VII win the whole derivative decision exists for: a thumbnail is re-fetched
    // constantly in dense lists. `private` still keeps shared caches out.
    expect(buildUploadHeaders({ ...png, isDerivative: true })['Cache-Control']).toBe(
      'private, max-age=300',
    );
  });

  it('an original is never stored', () => {
    // Opened deliberately, one at a time, and it still carries its EXIF — including GPS.
    expect(buildUploadHeaders({ ...png, isDerivative: false })['Cache-Control']).toBe(
      'private, no-store',
    );
    expect(buildUploadHeaders({ ...pdf, isDerivative: false })['Cache-Control']).toBe(
      'private, no-store',
    );
  });

  it('no variant is ever publicly cacheable', () => {
    for (const isDerivative of [true, false]) {
      const cc = buildUploadHeaders({ ...png, isDerivative })['Cache-Control'];
      expect(cc).toContain('private');
      expect(cc).not.toContain('public');
    }
  });
});
