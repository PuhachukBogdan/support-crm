import type { Response } from 'express';

/**
 * The hardened response posture for served bytes (feature 016, US2 — FR-012 / research R7).
 *
 * ⚠️ ONE PLACE, deliberately. Every byte the product serves leaves through this function, so a future
 * route cannot serve a file with a different posture by forgetting a header. `serve.spec.ts` pins
 * each header to the reason it exists rather than to its current value.
 *
 * This is the SECOND layer of the polyglot defence and it is honest about being the weaker one: it
 * stops a file being INTERPRETED and depends on the client obeying. The first layer — re-encoding
 * into a derivative — removes an appended payload by construction and depends on nothing. Originals
 * only ever get this layer, which is why they are opened deliberately and never rendered in lists.
 */

export interface UploadHeaderInput {
  /** The VERIFIED content type. Never the declared one — that is the whole of FR-006. */
  contentType: string;
  /** Sanitized display label; may be empty. */
  displayName: string;
  /** True only for raster images (a PDF is an active document with its own scripting). */
  inlineSafe: boolean;
  /** Derivatives are cacheable; originals are not. */
  isDerivative: boolean;
}

export function buildUploadHeaders(input: UploadHeaderInput): Record<string, string> {
  const disposition = input.inlineSafe ? 'inline' : 'attachment';
  const filename = headerSafeFilename(input.displayName);

  return {
    'Content-Type': input.contentType,
    // Without this the browser may re-decide the type from the bytes and defeat the server-side
    // allow-list entirely — the allow-list would constrain what we STORE and nothing about what a
    // client executes.
    'X-Content-Type-Options': 'nosniff',
    // A per-response sandbox, under the app-wide CSP (SEC-12) and scoped to the one response that
    // carries untrusted bytes. `default-src 'none'` means even a document that renders fetches
    // nothing; `sandbox` denies it an origin to act in.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': filename ? `${disposition}; filename="${filename}"` : disposition,
    // A derivative is a low-sensitivity thumbnail re-fetched constantly in dense lists, so caching it
    // IS the Principle-VII win the whole derivative decision exists for. An original is opened
    // deliberately, still carries its EXIF, and is not stored anywhere. `private` on both keeps
    // shared caches out regardless.
    'Cache-Control': input.isDerivative ? 'private, max-age=300' : 'private, no-store',
  };
}

/**
 * Last-line filename hardening for the header value.
 *
 * The label was already sanitized in `users` (`toDisplayLabel`), so this is defence in depth rather
 * than the primary control — but the header is where a CR, LF or quote actually becomes a forged
 * header, and this function is the last code that touches the value before it goes on the wire.
 * Removal, not escaping: escaping is one careless re-encode away from being undone.
 */
function headerSafeFilename(name: string): string {
  return (name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .trim();
}

/** Apply the headers and send the bytes. The only exit for file content in the product. */
export function sendUpload(res: Response, input: UploadHeaderInput, body: Uint8Array): void {
  for (const [header, value] of Object.entries(buildUploadHeaders(input))) {
    res.setHeader(header, value);
  }
  res.end(Buffer.from(body));
}
