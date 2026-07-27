import sharp from 'sharp';

/**
 * Image re-encoding for the upload path (feature 016, roadmap 4.9 — spec Q3 / research R5).
 *
 * ⚠️ THIS FILE HANDLES UNTRUSTED INPUT. It is not a formatting utility, and it must not be read as
 * one. Every byte reaching `makeDerivative` came from a client that may be hostile, and image
 * decoders are a classic source of memory-safety bugs. Q3 accepted that risk deliberately, in
 * exchange for the only STRUCTURAL answer to the polyglot case: a re-encoded derivative does not
 * contain an appended payload, whereas a response header only stops the payload being *interpreted*
 * and depends on the client obeying.
 *
 * Four guards, none of them optional:
 *
 *   • `limitInputPixels` — the byte cap limits what we ACCEPT, never the memory needed to decode it.
 *     A 40 KB PNG can declare 50 000 × 50 000. This is the decompression-bomb answer.
 *   • `failOn: 'error'` — a partially decodable file is a REFUSAL, not a best-effort thumbnail. A
 *     half-decoded derivative would be served to a user as though it were their file.
 *   • an explicit output format — never "keep the input format". The output is what we chose.
 *   • metadata stripped — sharp drops it unless asked otherwise, and `withMetadata()` is deliberately
 *     never called. This is also a privacy win: EXIF in a customer photo can carry GPS coordinates
 *     and a device id. Stated honestly — the ORIGINAL still carries them and is served only on a
 *     deliberate open, which is why lists are served the derivative.
 */

/**
 * Largest input we will decode, in pixels (~32 MP).
 *
 * The arithmetic behind the number: a decoded RGBA bitmap costs roughly `pixels × 4` bytes, so 32 MP
 * is on the order of 128 MB of peak decode memory — the same order as the ~200 MB unary-transport
 * ceiling computed in research R2, rather than a second, larger budget nobody accounted for.
 *
 * 32 MP is generous for what this product actually carries: screenshots are under 8 MP and phone
 * photos are typically saved at 12 MP. A 48 MP original is refused, and that is the accepted trade.
 * **Trigger to revisit**: a purpose that legitimately needs larger images — at which point the
 * limit becomes a catalogue field rather than a constant.
 */
export const MAX_INPUT_PIXELS = 32_000_000;

export type ImageRejectionReason = 'pixel_limit' | 'undecodable';

/** Refusal carries a REASON CODE — never the filename, never any part of the content (FR-020). */
export class ImageRejected extends Error {
  constructor(readonly reason: ImageRejectionReason) {
    super(`image refused: ${reason}`);
    this.name = 'ImageRejected';
  }
}

export interface Derivative {
  body: Uint8Array;
  contentType: 'image/webp';
  byteSize: number;
}

/**
 * Produce the small re-encoded copy of `input`, or throw {@link ImageRejected}.
 *
 * The dimension check is performed EXPLICITLY here, before the pipeline, even though
 * `limitInputPixels` below would also stop an oversized image. Two reasons, and the second is the
 * important one: it makes the refusal ATTRIBUTABLE — "too many pixels" and "corrupt file" are
 * genuinely different answers and a test can tell them apart — and it means the guarantee does not
 * rest on how a particular libvips version words its error. `limitInputPixels` stays on the pipeline
 * as the backstop it is meant to be.
 */
export async function makeDerivative(input: Uint8Array, longestEdge: number): Promise<Derivative> {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  let width = 0;
  let height = 0;
  try {
    // Header only — this does not decode the image, so reading the declared size costs nothing even
    // when the declared size is absurd.
    const meta = await sharp(buf, { limitInputPixels: false }).metadata();
    width = meta.width ?? 0;
    height = meta.height ?? 0;
  } catch {
    throw new ImageRejected('undecodable');
  }

  if (width <= 0 || height <= 0) throw new ImageRejected('undecodable');
  if (width * height > MAX_INPUT_PIXELS) throw new ImageRejected('pixel_limit');

  try {
    const body = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      // Applies EXIF orientation so the thumbnail is the right way up, then discards the tag with
      // the rest of the metadata. Without this a rotated phone photo thumbnails sideways.
      .rotate()
      .resize({
        width: longestEdge,
        height: longestEdge,
        fit: 'inside',
        withoutEnlargement: true, // a 32 px avatar stays 32 px; upscaling invents detail
      })
      .webp({ quality: 80 })
      .toBuffer();
    return { body: Uint8Array.from(body), contentType: 'image/webp', byteSize: body.byteLength };
  } catch {
    // The cause is deliberately not attached: a decoder error message can echo file content.
    throw new ImageRejected('undecodable');
  }
}
