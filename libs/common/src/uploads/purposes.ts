/**
 * The upload-purpose catalogue (feature 016, roadmap 4.9 — research R11, FR-002/FR-003).
 *
 * ── Why a catalogue and not parameters ───────────────────────────────────────────────────────────
 * Closed and additive, the same discipline as the permission catalogue (011), the automation-trigger
 * catalogue (014) and the audit-action catalogue (015). Every member has a reason to exist and an
 * unknown member resolves to NOTHING — there is no permissive default anywhere in this file, because
 * a default is how a purpose nobody reviewed gets a size cap nobody chose.
 *
 * ── This file is the whole of FR-003 ─────────────────────────────────────────────────────────────
 * Adding a consumer means adding a ROW here. No validation code branches on a purpose name, and
 * `libs/common/src/uploads/second-purpose.spec.ts` asserts that as a scan over the validation path
 * rather than trusting it as a style preference. ADR 0035's avatar limits are a row, which is
 * exactly the claim the ADR made when it said the avatar waits for this feature.
 *
 * ── Where the permission comes from ──────────────────────────────────────────────────────────────
 * A purpose NAMES an existing key from the feature-011 catalogue; this feature introduces no new
 * permission. `permission: null` is explicit and means "authenticated is sufficient" — never "no
 * check". Setting your own avatar is a self-service profile action, and the consumer at 8.10
 * enforces "your own profile"; inventing a `crm.avatar.upload` key would be a key with one holder,
 * everyone.
 */
import { isRasterImage, type DetectableContentType } from './content-type';

/**
 * Whether the ingest path stores a small re-encoded copy alongside the original.
 *
 * `never`       — no derivative, ever (a purpose that carries no images).
 * `images-only` — a derivative for the image types in the list; the non-image ones simply have none.
 * `always`      — the same runtime behaviour, plus a CLAIM about the catalogue: every type this
 *                 purpose allows is an image, so "no derivative" cannot happen. The claim is not
 *                 decoration — `purposes.spec.ts` fails the build if an `always` purpose ever gains
 *                 a non-image type, which is the review moment that would otherwise be silent.
 */
export type DerivativePolicy = 'never' | 'images-only' | 'always';

export interface UploadPurpose {
  /** An existing feature-011 permission key, or null = authenticated is sufficient (never "no check"). */
  readonly permission: string | null;
  /** Refused above this, before the whole file has been accepted (FR-007). */
  readonly maxBytes: number;
  /** Closed allow-list, by CONTENT (FR-005/FR-006). SVG is absent from every list, by construction. */
  readonly types: readonly DetectableContentType[];
  readonly derivative: DerivativePolicy;
  /** Longest edge of the derivative, in pixels. Data, so no code decides a size per purpose. */
  readonly derivativeLongestEdge: number;
}

const MB = 1024 * 1024;

export const UPLOAD_PURPOSES = {
  /**
   * A file an agent attaches to a conversation message (this feature's only live consumer).
   * Gated by the reply permission itself: attaching to a reply is part of replying, so it needs no
   * key of its own (spec Assumptions). PNG/JPEG/WebP/GIF/PDF is what a support conversation actually
   * carries — screenshots and receipts. Office documents and archives are deliberately absent: a
   * container format that nothing inspects is a permitted type in name only.
   */
  message_attachment: {
    permission: 'crm.conversation.reply',
    maxBytes: 10 * MB,
    types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
    derivative: 'images-only',
    derivativeLongestEdge: 256,
  },

  /**
   * The profile avatar. Limits fixed by ADR 0035 (2 MB; PNG/JPEG/WebP by content; SVG excluded) —
   * reproduced here as data, which is the FR-003/SC-009 claim being made rather than described.
   *
   * ⚠️ BINDING NOTE FOR ROADMAP 8.10 — the avatar consumer MUST claim its upload.
   * Nothing claims it today, so an avatar registered through this purpose stays `pending` forever.
   * A future reclaim job (ADR 0015) collects `pending` uploads, and would therefore delete avatars
   * that are in active use. Cheap to write down now; silent data loss to discover later.
   */
  avatar: {
    permission: null,
    maxBytes: 2 * MB,
    types: ['image/png', 'image/jpeg', 'image/webp'],
    derivative: 'always',
    derivativeLongestEdge: 256,
  },
} as const satisfies Record<string, UploadPurpose>;

export type UploadPurposeName = keyof typeof UPLOAD_PURPOSES;

/** Every registered purpose name. The catalogue is closed: this is the complete set. */
export const UPLOAD_PURPOSE_NAMES = Object.keys(UPLOAD_PURPOSES) as UploadPurposeName[];

export function isUploadPurpose(value: string | undefined): value is UploadPurposeName {
  return !!value && Object.prototype.hasOwnProperty.call(UPLOAD_PURPOSES, value);
}

/**
 * The catalogue entry for `value`, or `null` when the purpose does not exist.
 *
 * `null` is the refusal (FR-002). Every caller must treat it as one — there is deliberately no
 * `?? DEFAULT_PURPOSE` anywhere, because a fallback here would hand an unreviewed upload the most
 * permissive limits in the catalogue.
 */
export function purposeOf(value: string | undefined): UploadPurpose | null {
  if (!isUploadPurpose(value)) return null;
  return UPLOAD_PURPOSES[value];
}

/** True iff `contentType` is on this purpose's allow-list. */
export function purposeAllowsType(purpose: UploadPurpose, contentType: string): boolean {
  return (purpose.types as readonly string[]).includes(contentType);
}

/**
 * Whether a derivative is produced for an accepted file of `contentType` under `purpose`.
 * Reads the catalogue and the type; names no purpose (SC-009).
 */
export function shouldProduceDerivative(purpose: UploadPurpose, contentType: string): boolean {
  if (purpose.derivative === 'never') return false;
  return isRasterImage(contentType);
}
