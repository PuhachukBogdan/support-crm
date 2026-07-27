import {
  detectContentType,
  purposeOf,
  purposeAllowsType,
  shouldProduceDerivative,
  toDisplayLabel,
  type DetectableContentType,
  type UploadPurpose,
} from '@crm/common';
import { ImageRejected, makeDerivative, type Derivative } from './image';

/**
 * The single validation gate for incoming bytes (feature 016, US1 — FR-002/005/006/007/009).
 *
 * ── Pure, apart from the decode ──────────────────────────────────────────────────────────────────
 * No database, no bucket, no clock, no randomness. That is why `validate.spec.ts` can exercise the
 * decision exhaustively without any I/O, and why the component that decides whether bytes are
 * acceptable can be reasoned about on its own.
 *
 * ── Order is a cost decision, not an aesthetic one ───────────────────────────────────────────────
 *   purpose → size → content → (image) decode
 * Each step is cheaper than the next and refuses more input, so nothing expensive is ever done to
 * input already known to be refused. The size check in particular must precede the content check:
 * inspecting and then decoding an oversized buffer is work spent on a request that cannot succeed.
 *
 * ── A refusal is total ───────────────────────────────────────────────────────────────────────────
 * This function stores nothing and writes nothing — it cannot, it has no collaborators. The caller
 * only reaches the object store after it returns, which is what makes FR-009 ("a rejected upload
 * leaves nothing behind") a property of the ORDERING rather than of a cleanup path.
 */

export type UploadRejectionReason =
  | 'unknown_purpose'
  | 'empty_file'
  | 'too_large'
  | 'type_not_allowed'
  | 'declared_type_mismatch'
  | 'image_too_large'
  | 'undecodable_image';

/**
 * Refusal carries a REASON CODE and nothing else.
 *
 * Not the filename (it can be PII — `john_smith_passport.jpg`), not a byte, not the declared type.
 * This error is logged and surfaced, so anything it carries is something that leaks (FR-020/SEC-26).
 */
export class UploadRejected extends Error {
  constructor(readonly reason: UploadRejectionReason) {
    super(`upload refused: ${reason}`);
    this.name = 'UploadRejected';
  }
}

export interface UploadInput {
  purpose: string;
  declaredContentType: string;
  filename: string;
  content: Uint8Array;
}

export interface ValidatedUpload {
  purposeName: string;
  purpose: UploadPurpose;
  /** VERIFIED from content. The declared value is compared, then discarded — it is never returned. */
  contentType: DetectableContentType;
  bytes: Uint8Array;
  displayName: string | null;
  derivative: Derivative | null;
}

/**
 * Declared types that mean "I am not making a claim". Treating these as a disagreement would refuse
 * honest clients (curl without an explicit part type, some HTTP libraries) while adding nothing: the
 * detected type governs regardless, so an absent claim cannot mislead anyone.
 */
const NO_CLAIM = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Aliases browsers and tools genuinely emit. Normalising them is not trusting them. */
const ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};

function normalizeDeclared(value: string | undefined): string {
  const v = (value ?? '').trim().toLowerCase().split(';')[0]!.trim();
  return ALIASES[v] ?? v;
}

export async function validateUpload(input: UploadInput): Promise<ValidatedUpload> {
  // 1) The purpose must exist. There is no permissive default anywhere in this path — an unknown
  //    purpose is the one case where "carry on with sensible limits" would be catastrophic, because
  //    the limits would be nobody's decision.
  const purpose = purposeOf(input.purpose);
  if (!purpose) throw new UploadRejected('unknown_purpose');

  // 2) Size. An empty file is either a client bug or a probe, and it has no content to validate.
  const size = input.content.byteLength;
  if (size === 0) throw new UploadRejected('empty_file');
  if (size > purpose.maxBytes) throw new UploadRejected('too_large');

  // 3) Content. The bytes decide; the extension is not consulted at all and the declared type only
  //    gets to be WRONG, never to be right on the file's behalf.
  const detected = detectContentType(input.content);
  if (!detected) throw new UploadRejected('type_not_allowed');
  if (!purposeAllowsType(purpose, detected)) throw new UploadRejected('type_not_allowed');

  const declared = normalizeDeclared(input.declaredContentType);
  if (!NO_CLAIM.has(declared) && declared !== detected) {
    throw new UploadRejected('declared_type_mismatch');
  }

  // 4) For image purposes the real validation is the DECODE: recognising a header is not parsing a
  //    file, and a file sharp cannot decode as the type we detected is not that type.
  let derivative: Derivative | null = null;
  if (shouldProduceDerivative(purpose, detected)) {
    try {
      derivative = await makeDerivative(input.content, purpose.derivativeLongestEdge);
    } catch (err) {
      if (err instanceof ImageRejected) {
        throw new UploadRejected(
          err.reason === 'pixel_limit' ? 'image_too_large' : 'undecodable_image',
        );
      }
      throw err;
    }
  }

  return {
    purposeName: input.purpose,
    purpose,
    contentType: detected,
    bytes: input.content,
    displayName: toDisplayLabel(input.filename),
    derivative,
  };
}
