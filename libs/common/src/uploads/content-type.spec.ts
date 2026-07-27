import {
  detectContentType,
  isInlineSafe,
  isRasterImage,
  DETECTABLE_CONTENT_TYPES,
} from './content-type';

/**
 * T010 (feature 016) — content decides the type, and the table IS the allow-list (FR-006 / SC-003).
 *
 * Headers are built here rather than committed as binary fixtures: they are synthetic and
 * brand-neutral by construction (Principle V/VI), and a reader can see exactly what is being fed in
 * instead of trusting a checked-in blob.
 */
const bytes = (...b: number[]) => Uint8Array.from(b);

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
const GIF87 = bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00);
const GIF89 = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const WEBP = bytes(
  0x52, 0x49, 0x46, 0x46, // RIFF
  0x24, 0x00, 0x00, 0x00, // little-endian length
  0x57, 0x45, 0x42, 0x50, // WEBP
  0x56, 0x50, 0x38, 0x20, // VP8␠
);

/** \x7fELF — the renamed-executable case SC-003 names explicitly. */
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');

describe('every permitted format is detected from its own bytes', () => {
  it.each([
    ['image/png', PNG],
    ['image/jpeg', JPEG],
    ['image/webp', WEBP],
    ['image/gif', GIF87],
    ['image/gif', GIF89],
    ['application/pdf', PDF],
  ])('%s', (expected, buf) => {
    expect(detectContentType(buf as Uint8Array)).toBe(expected);
  });

  it('the table covers exactly the declared set — nothing detectable is undeclared', () => {
    const detected = new Set(
      [PNG, JPEG, WEBP, GIF87, GIF89, PDF].map((b) => detectContentType(b)),
    );
    expect([...detected].sort()).toEqual([...DETECTABLE_CONTENT_TYPES].sort());
  });
});

describe('anything else is refused (FR-005 — a closed allow-list, not a deny-list)', () => {
  it('*** an ELF executable is refused however it is named or declared ***', () => {
    // The declared type and the extension are not arguments to this function, which is the point:
    // there is no parameter here for a client to lie in.
    expect(detectContentType(ELF)).toBeNull();
  });

  it('*** a valid SVG is refused *** — it is absent from the table, so it can never be accepted', () => {
    expect(detectContentType(SVG)).toBeNull();
  });

  it('a truncated file is refused, not partially matched', () => {
    // Three bytes of a PNG signature are not a PNG. Fail-closed on length is what stops a short
    // read resolving to whatever it happens to begin with.
    expect(detectContentType(PNG.slice(0, 3))).toBeNull();
    // RIFF with no room for the WEBP tag at offset 8.
    expect(detectContentType(WEBP.slice(0, 6))).toBeNull();
  });

  it('a zero-byte file is refused', () => {
    expect(detectContentType(bytes())).toBeNull();
  });

  it('a RIFF container that is not WebP is refused (WAVE shares the first four bytes)', () => {
    const wave = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(detectContentType(wave)).toBeNull();
  });

  it('a plausible-looking text file is refused', () => {
    expect(detectContentType(new TextEncoder().encode('GIF but not really'))).toBeNull();
    expect(detectContentType(new TextEncoder().encode('%PDF is mentioned later, not first'))).toBeNull();
  });
});

describe('*** the magic check alone is NOT sufficient, and this pins why ***', () => {
  it('a JPEG with an HTML payload appended still detects as a JPEG', () => {
    const polyglot = new Uint8Array([
      ...JPEG,
      ...new TextEncoder().encode('<script>alert(document.domain)</script>'),
    ]);
    expect(detectContentType(polyglot)).toBe('image/jpeg');
    // …and that is correct behaviour, not a bug. Recognising a header is not parsing a file.
    // The polyglot is answered STRUCTURALLY by re-encoding (services/users/src/uploads/image.ts):
    // the derivative does not contain the payload. The serving headers (research R7) are the second
    // layer and depend on the client obeying; the re-encode does not.
  });
});

describe('serving posture is derived from the verified type', () => {
  it('raster images are inline-safe; a PDF is not', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(isRasterImage(t)).toBe(true);
      expect(isInlineSafe(t)).toBe(true);
    }
    // A PDF renders as an active document with its own scripting — `attachment`, never `inline`.
    expect(isRasterImage('application/pdf')).toBe(false);
    expect(isInlineSafe('application/pdf')).toBe(false);
  });

  it('a type outside the allow-list is never inline-safe', () => {
    expect(isInlineSafe('image/svg+xml')).toBe(false);
    expect(isInlineSafe('text/html')).toBe(false);
  });
});
