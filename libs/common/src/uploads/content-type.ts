/**
 * Content-type detection by MAGIC BYTES (feature 016, roadmap 4.9 — research R4).
 *
 * ── The table IS the allow-list ──────────────────────────────────────────────────────────────────
 * There is no second list of "permitted types" for this one to drift away from. A format we cannot
 * recognise from its own bytes is a format we do not accept, and that is the same sentence.
 *
 * ── Why hand-written, not `file-type` ────────────────────────────────────────────────────────────
 * The obvious dependency is ESM-only from v17 and this repo is CommonJS under `@swc/jest` and `tsx` —
 * the exact class of friction that produced the Prisma-7 and decorator-metadata gotchas. Pinning an
 * old CJS release to obtain a 400-format detection table is the wrong trade when the allow-list is
 * five formats.
 *
 * ── What this does NOT do, deliberately ──────────────────────────────────────────────────────────
 * Recognising a header is not parsing a file. A JPEG with an HTML payload appended still detects as
 * a JPEG, and it should: the polyglot answer is the RE-ENCODE in `services/users/src/uploads/image.ts`,
 * whose output simply does not contain the payload. This module is the cheap, fail-fast first layer;
 * `content-type.spec.ts` pins that limitation with a test rather than leaving it implied.
 *
 * The declared MIME type and the filename extension are never consulted here — that is the whole of
 * FR-006. They are inputs to a lie; the bytes are not.
 */

/** Every type the product can accept. A purpose narrows this; nothing widens it. */
export const DETECTABLE_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type DetectableContentType = (typeof DETECTABLE_CONTENT_TYPES)[number];

/**
 * Raster images: the types a derivative can be produced from, and the only types safe to serve
 * `inline` (research R7 — a PDF renders as an active document with its own scripting; an image
 * does not).
 */
export const RASTER_IMAGE_TYPES: readonly DetectableContentType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export function isRasterImage(contentType: string): boolean {
  return (RASTER_IMAGE_TYPES as readonly string[]).includes(contentType);
}

/** True for types that may be served with `Content-Disposition: inline` (R7). */
export function isInlineSafe(contentType: string): boolean {
  return isRasterImage(contentType);
}

/** One signature: every `bytes` sequence must match at its `at` offset. */
interface Signature {
  readonly type: DetectableContentType;
  readonly parts: ReadonlyArray<{ readonly at: number; readonly bytes: readonly number[] }>;
}

const SIGNATURES: readonly Signature[] = [
  // \x89 P N G \r \n \x1a \n — the full 8-byte signature, not just "PNG".
  {
    type: 'image/png',
    parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  // SOI + the first marker byte. Every JPEG variant (JFIF, Exif, raw) starts this way.
  { type: 'image/jpeg', parts: [{ at: 0, bytes: [0xff, 0xd8, 0xff] }] },
  // RIFF....WEBP — two parts with the 4-byte little-endian length between them, which is why a
  // single contiguous prefix cannot express this signature.
  {
    type: 'image/webp',
    parts: [
      { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  { type: 'image/gif', parts: [{ at: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] }] }, // GIF87a
  { type: 'image/gif', parts: [{ at: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] }] }, // GIF89a
  // %PDF-
  { type: 'application/pdf', parts: [{ at: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }] },
];

function matches(buf: Uint8Array, sig: Signature): boolean {
  for (const part of sig.parts) {
    // A file too short to carry the signature is a refusal, not a partial match — this is what
    // makes a truncated upload fail closed instead of resolving to whatever it happens to start with.
    if (buf.length < part.at + part.bytes.length) return false;
    for (let i = 0; i < part.bytes.length; i += 1) {
      if (buf[part.at + i] !== part.bytes[i]) return false;
    }
  }
  return true;
}

/**
 * The content type implied by `buf`'s own bytes, or `null` when it is not a format we accept.
 *
 * `null` is a refusal, never "unknown, carry on". SVG returns `null` because it is absent from the
 * table, which is precisely how an active-document format is excluded (FR-005) — by not being
 * listed, rather than by a deny-list somebody has to remember to extend.
 */
export function detectContentType(buf: Uint8Array): DetectableContentType | null {
  if (buf.length === 0) return null;
  for (const sig of SIGNATURES) {
    if (matches(buf, sig)) return sig.type;
  }
  return null;
}
