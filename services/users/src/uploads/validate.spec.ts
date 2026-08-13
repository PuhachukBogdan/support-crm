import { UPLOAD_PURPOSES } from '@crm/common';
import { validateUpload, UploadRejected } from './validate';

/**
 * T024 (feature 016, US1) — the ingest refuses everything it cannot vouch for, and a refusal is
 * TOTAL: nothing stored, no row, no partial anything (FR-009 / SC-003).
 *
 * `validateUpload` is pure apart from the image decode, which is why almost all of this runs with no
 * I/O at all. That is a design property worth naming: the component that decides whether bytes are
 * acceptable does not need a database or a bucket to be tested, so the decision can be exercised
 * exhaustively and cheaply.
 *
 * Headers are built here rather than committed as binaries — synthetic and brand-neutral by
 * construction (Principle V/VI), and a reader can see exactly what is being fed in.
 */
const bytes = (...b: number[]) => Uint8Array.from(b);

const PNG_HEADER = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3);
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00);
const SVG = new TextEncoder().encode(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
);

const ATTACHMENT = 'message_attachment';

async function reject(input: Parameters<typeof validateUpload>[0]): Promise<UploadRejected> {
  try {
    await validateUpload(input);
  } catch (err) {
    if (err instanceof UploadRejected) return err;
    throw err;
  }
  throw new Error('expected the upload to be refused');
}

describe('the purpose must exist (FR-002)', () => {
  it('an unknown purpose is refused before anything else happens', async () => {
    const err = await reject({
      purpose: 'nonsense',
      declaredContentType: 'application/pdf',
      filename: 'x.pdf',
      content: PDF,
    });
    expect(err.reason).toBe('unknown_purpose');
  });

  it('an empty purpose is refused — there is no default', async () => {
    const err = await reject({
      purpose: '',
      declaredContentType: 'application/pdf',
      filename: 'x.pdf',
      content: PDF,
    });
    expect(err.reason).toBe('unknown_purpose');
  });
});

describe('content decides the type (FR-006 / SC-003)', () => {
  it('*** an ELF renamed to .png and declared image/png is refused ***', async () => {
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'image/png',
      filename: 'holiday-photo.png',
      content: ELF,
    });
    // Not "declared type mismatch" — the file is not ANY permitted type. The lie is incidental;
    // the refusal would stand even if the client had declared nothing at all.
    expect(err.reason).toBe('type_not_allowed');
  });

  it('*** a valid SVG is refused *** — an active-document format is absent from every allow-list', async () => {
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'image/svg+xml',
      filename: 'logo.svg',
      content: SVG,
    });
    expect(err.reason).toBe('type_not_allowed');
  });

  it('a declared type that disagrees with real, permitted content is refused (FR-006)', async () => {
    // Both are permitted types, so the allow-list would let this through. The disagreement itself is
    // the refusal: a client that mislabels a file is either broken or probing, and neither deserves
    // a stored object.
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'image/png',
      filename: 'receipt.png',
      content: PDF,
    });
    expect(err.reason).toBe('declared_type_mismatch');
  });

  it('a type permitted elsewhere but not by THIS purpose is refused', async () => {
    // A PDF is a legitimate attachment and never an avatar. Same code, different catalogue row —
    // the FR-003 property, exercised rather than described.
    const err = await reject({
      purpose: 'avatar',
      declaredContentType: 'application/pdf',
      filename: 'cv.pdf',
      content: PDF,
    });
    expect(err.reason).toBe('type_not_allowed');
  });

  it('a generic declared type is not treated as a disagreement', async () => {
    // `application/octet-stream` (curl with no --form type, some clients) is the ABSENCE of a claim,
    // not a false one. Refusing it would break honest clients while the detected type still governs.
    const ok = await validateUpload({
      purpose: ATTACHMENT,
      declaredContentType: 'application/octet-stream',
      filename: 'receipt.pdf',
      content: PDF,
    });
    expect(ok.contentType).toBe('application/pdf');
  });
});

describe('size and emptiness', () => {
  it('a zero-byte file is refused', async () => {
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: 'empty.pdf',
      content: bytes(),
    });
    expect(err.reason).toBe('empty_file');
  });

  it('a file over the purpose cap is refused', async () => {
    const oversized = new Uint8Array(UPLOAD_PURPOSES[ATTACHMENT].maxBytes + 1);
    oversized.set(PDF, 0);
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: 'huge.pdf',
      content: oversized,
    });
    expect(err.reason).toBe('too_large');
  });

  it('the cap is the PURPOSE’s, not a global one', async () => {
    // Comfortably inside the 10 MB attachment cap, comfortably outside the 2 MB avatar cap. One
    // code path, two answers, decided entirely by the catalogue row.
    const threeMb = new Uint8Array(3 * 1024 * 1024);
    threeMb.set(PDF, 0);
    const asAttachment = await validateUpload({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: 'report.pdf',
      content: threeMb,
    });
    expect(asAttachment.contentType).toBe('application/pdf');

    const png3mb = new Uint8Array(3 * 1024 * 1024);
    png3mb.set(PNG_HEADER, 0);
    const err = await reject({
      purpose: 'avatar',
      declaredContentType: 'image/png',
      filename: 'me.png',
      content: png3mb,
    });
    expect(err.reason).toBe('too_large');
  });

  it('the size check runs BEFORE the content check', async () => {
    // Order matters for cost: inspecting (and later decoding) an oversized buffer is work done on
    // input already known to be refused.
    const oversizedGarbage = new Uint8Array(UPLOAD_PURPOSES[ATTACHMENT].maxBytes + 1);
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'image/png',
      filename: 'x.png',
      content: oversizedGarbage,
    });
    expect(err.reason).toBe('too_large'); // not `type_not_allowed`
  });
});

describe('what a successful validation returns', () => {
  it('a PDF attachment: verified type, sanitized label, and NO derivative', async () => {
    const ok = await validateUpload({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: '../../etc/receipt.pdf',
      content: PDF,
    });
    expect(ok.contentType).toBe('application/pdf');
    expect(ok.displayName).toBe('receipt.pdf'); // traversal gone (FR-008)
    expect(ok.derivative).toBeNull(); // a PDF cannot be re-encoded to a thumbnail
    expect(ok.bytes).toBe(PDF); // the original is passed through untouched
  });

  it('the DECLARED type is not carried forward anywhere', async () => {
    const ok = await validateUpload({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: 'receipt.pdf',
      content: PDF,
    });
    // Storing what the client claimed would create a field that looks authoritative and is not.
    expect(Object.keys(ok)).not.toContain('declaredContentType');
    expect(JSON.stringify(Object.keys(ok))).not.toMatch(/declared/i);
  });

  it('an unusable filename yields no display name rather than an invented one', async () => {
    const ok = await validateUpload({
      purpose: ATTACHMENT,
      declaredContentType: 'application/pdf',
      filename: '   ',
      content: PDF,
    });
    expect(ok.displayName).toBeNull();
  });
});

describe('*** a refusal never mentions the filename or the bytes *** (FR-020 / SEC-26)', () => {
  it('the error carries a reason code, not the input', async () => {
    const err = await reject({
      purpose: ATTACHMENT,
      declaredContentType: 'image/png',
      filename: 'john_smith_passport.png',
      content: ELF,
    });
    const serialized = `${err.message} ${JSON.stringify(err.reason)} ${err.stack ?? ''}`;
    expect(serialized).not.toContain('john_smith_passport');
    expect(serialized).not.toContain('passport');
  });
});

/**
 * Feature 017 (roadmap 4.10 — research R5): a PRODUCED artefact is validated by provenance, not by a
 * signature. FAILS before the `origin` branch exists (a CSV detects as nothing and is refused), PASSES
 * after.
 */
describe('*** produced artefacts: the inverse check ***', () => {
  const csv = () => Buffer.from('id,status\r\nc1,open\r\n', 'utf8');

  it("accepts a CSV we produced, and reports the purpose's own type", async () => {
    // The whole point of R5: `text/csv` is deliberately ABSENT from the detection table, so this path
    // cannot work by matching a signature. Adding csv to that table would have made a faith-based type
    // reachable from every future untrusted purpose.
    const v = await validateUpload({
      purpose: 'conversation_export',
      declaredContentType: 'text/csv',
      filename: 'conversations-2026-07-28.csv',
      content: csv(),
    });
    expect(v.contentType).toBe('text/csv');
    expect(v.derivative).toBeNull();
  });

  it('REFUSES bytes carrying a binary signature — a produced text artefact must not be binary', async () => {
    // The check that earns its place: a future bug (or an injected field) putting binary content into a
    // text artefact is caught here, and a disguised PNG/PDF/ELF is still refused on this path.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await expect(
      validateUpload({
        purpose: 'conversation_export',
        declaredContentType: 'text/csv',
        filename: 'x.csv',
        content: png,
      }),
    ).rejects.toMatchObject({ reason: 'type_not_allowed' });
  });

  it('REFUSES invalid UTF-8', async () => {
    const invalid = Buffer.from([0x69, 0x64, 0xff, 0xfe, 0x0a]);
    await expect(
      validateUpload({
        purpose: 'conversation_export',
        declaredContentType: 'text/csv',
        filename: 'x.csv',
        content: invalid,
      }),
    ).rejects.toMatchObject({ reason: 'type_not_allowed' });
  });

  it('still enforces the size cap and refuses an empty file', async () => {
    await expect(
      validateUpload({
        purpose: 'conversation_export',
        declaredContentType: 'text/csv',
        filename: 'x.csv',
        content: Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ reason: 'empty_file' });

    await expect(
      validateUpload({
        purpose: 'conversation_export',
        declaredContentType: 'text/csv',
        filename: 'x.csv',
        content: Buffer.alloc(11 * 1024 * 1024, 0x61),
      }),
    ).rejects.toMatchObject({ reason: 'too_large' });
  });

  it('an INGESTED purpose is unaffected — a CSV is still refused there', async () => {
    // The strict rule must stay strict everywhere bytes come from someone else.
    await expect(
      validateUpload({
        purpose: 'message_attachment',
        declaredContentType: 'text/csv',
        filename: 'x.csv',
        content: csv(),
      }),
    ).rejects.toMatchObject({ reason: 'type_not_allowed' });
  });
});
