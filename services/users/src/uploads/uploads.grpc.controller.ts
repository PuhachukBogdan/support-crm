import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { isInlineSafe, isUploadPurpose } from '@crm/common';
import { UploadsRepository, ClaimRefused, type UploadRow } from './uploads.repository';
import { UploadRejected, validateUpload } from './validate';
import { assertNotPreview, assertPurposePermission, readUploadActor } from './actor';

/**
 * `UploadsService` — the only surface through which bytes enter the product (feature 016, FR-001).
 *
 * Every handler does the same three things in the same order before touching anything: read the
 * actor (fail-closed on a missing account), resolve the purpose from the CLOSED catalogue, and
 * re-check the purpose's permission independently of the gateway (Principle II).
 *
 * ── The id-list cap is not decoration ────────────────────────────────────────────────────────────
 * `repeated string` with no bound is an unbounded request on an authenticated path: ten thousand ids
 * turn one call into a scan (Principle VII / FR-023). The cap is enforced HERE as well as at the
 * gateway, because a caller that skips the gateway must hit the same wall.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

/** Both id-list RPCs refuse above this. Matches the cap documented on the contract. */
export const MAX_UPLOAD_IDS = 50;

interface CreateUploadWire {
  purpose?: string;
  declaredContentType?: string;
  filename?: string;
  content?: Uint8Array | Buffer;
}
interface ReadUploadWire {
  uploadId?: string;
  variant?: string;
}
interface ClaimUploadsWire {
  uploadIds?: string[];
  claimedBy?: string;
}
interface DescribeUploadsWire {
  uploadIds?: string[];
}

const invalid = (message: string) =>
  new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });

/**
 * One refusal, one message. "Not yours" and "does not exist" must be INDISTINGUISHABLE (FR-011), so
 * they are literally the same object rather than two calls that happen to agree today.
 */
const notFound = () => new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

/** The wire shape of an upload. Note what is ABSENT: the storage key and the declared type. */
export function toUploadWire(row: UploadRow) {
  return {
    id: row.id,
    purpose: row.purpose,
    contentType: row.content_type, // the VERIFIED type
    byteSize: row.byte_size,
    displayName: row.display_name ?? '',
    hasDerivative: row.derivative_key !== null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Validate an inbound id list: present, non-empty, all strings, within the cap. */
function readIds(raw: string[] | undefined): string[] {
  const ids = Array.isArray(raw) ? raw : [];
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw invalid('invalid upload id');
  }
  if (ids.length > MAX_UPLOAD_IDS) throw invalid('too many upload ids');
  return ids;
}

@Controller()
export class UploadsGrpcController {
  constructor(@Inject(UploadsRepository) private readonly uploads: UploadsRepository) {}

  @GrpcMethod('UploadsService', 'CreateUpload')
  async createUpload(req: CreateUploadWire, metadata: Metadata) {
    const actor = readUploadActor(metadata);
    assertNotPreview(actor);

    // The purpose is checked against the catalogue BEFORE the permission, so an unknown purpose is
    // an INVALID_ARGUMENT rather than a PERMISSION_DENIED — otherwise "no such purpose" and "you may
    // not use this purpose" would be indistinguishable, and a typo would look like a policy problem.
    const purposeName = req?.purpose ?? '';
    if (!isUploadPurpose(purposeName)) throw invalid('unknown purpose');
    assertPurposePermission(actor, purposeName);

    const content = req?.content;
    if (!content || content.byteLength === 0) throw invalid('empty_file');

    let validated;
    try {
      validated = await validateUpload({
        purpose: purposeName,
        declaredContentType: req?.declaredContentType ?? '',
        filename: req?.filename ?? '',
        content: content instanceof Uint8Array ? content : Uint8Array.from(content),
      });
    } catch (err) {
      // The reason is a closed code (`too_large`, `type_not_allowed`, …) — PII-free by construction,
      // so it is safe to hand to the client and genuinely useful there.
      if (err instanceof UploadRejected) throw invalid(err.reason);
      throw err;
    }

    const row = await this.uploads.create(actor.accountId, actor.userId, validated);
    return toUploadWire(row);
  }

  /**
   * Serve stored bytes back (feature 016, US2 — FR-010/FR-011).
   *
   * ── Authorization is evaluated HERE, every time ────────────────────────────────────────────────
   * Nothing is cached and nothing is carried over from when a reference was produced. That is the
   * whole of "a link is not a key": a reference that was once usable stops working the moment the
   * requester's account or permissions change, which is also why this feature issues no presigned
   * URL anywhere (a signed URL moves the decision to link-creation time — the SEC-10 case).
   *
   * ── Two refusals, and why they differ ──────────────────────────────────────────────────────────
   * NOT_FOUND covers "another account" and "does not exist" IDENTICALLY — anything else is an
   * existence oracle (FR-011). PERMISSION_DENIED covers a caller who lacks the purpose's key: the
   * permission is a property of the PURPOSE, not of the object, so answering honestly leaks nothing
   * object-specific and tells a legitimately de-permissioned agent something true.
   */
  @GrpcMethod('UploadsService', 'ReadUpload')
  async readUpload(req: ReadUploadWire, metadata: Metadata) {
    const actor = readUploadActor(metadata);
    const row = await this.uploads.resolveForRead(actor.accountId, req?.uploadId ?? '');
    if (!row) throw notFound();
    assertPurposePermission(actor, row.purpose);

    const wantsDerivative = req?.variant === 'UPLOAD_VARIANT_DERIVATIVE';
    // A purpose with no derivative is NOT_FOUND, never a silent fallback to the original: falling
    // back would serve a full-size PDF to a caller that asked for a thumbnail and will render it as
    // an image. The check precedes the fetch, so nothing is read for a request that cannot succeed.
    const key = wantsDerivative ? row.derivative_key : row.storage_key;
    if (!key) throw notFound();

    const content = await this.uploads.fetchObject(key);
    // A row whose object is gone is NOT_FOUND, not a 500: it is a real (if rare) state, and the
    // caller can do nothing with the distinction.
    if (!content) throw notFound();

    const contentType = wantsDerivative ? 'image/webp' : row.content_type;
    return {
      contentType,
      displayName: row.display_name ?? '',
      // Derived from the VERIFIED type — a derivative is always a raster image we produced.
      inlineSafe: isInlineSafe(contentType),
      content,
    };
  }

  /**
   * Claim uploads on behalf of a consumer about to reference them (research R8).
   *
   * All-or-nothing: any id that is unknown, already claimed, or in another account fails the whole
   * call, and the three are indistinguishable in the response (FR-011/FR-015).
   */
  @GrpcMethod('UploadsService', 'ClaimUploads')
  async claimUploads(req: ClaimUploadsWire, metadata: Metadata) {
    const actor = readUploadActor(metadata);
    assertNotPreview(actor);
    const ids = readIds(req?.uploadIds);
    if (ids.length === 0) return { uploadIds: [] };

    // The permission is the PURPOSE's, and the purpose lives on the row — so the rows are read
    // first, through the scoped client. A row from another account is simply not in `rows`, which
    // makes the count check below the account boundary as well as the existence check.
    const rows = await this.uploads.describe(actor.accountId, ids);
    if (rows.length !== new Set(ids).size) {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'claim refused' });
    }
    for (const row of rows) assertPurposePermission(actor, row.purpose);

    try {
      const claimed = await this.uploads.claim(actor.accountId, ids, req?.claimedBy ?? '');
      return { uploadIds: claimed };
    } catch (err) {
      if (err instanceof ClaimRefused) {
        throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'claim refused' });
      }
      throw err;
    }
  }

  /**
   * Rendering metadata for an explicit, capped set of ids. No bytes.
   *
   * An id the caller may not see is ABSENT rather than an error — for a cross-account id because
   * FR-011 requires it, and for a purpose the caller lacks the permission for because this is a
   * batch call behind a thread page: refusing the whole page over one unreadable attachment would
   * turn a rendering detail into an outage. Reading the BYTES still requires the permission, every
   * time, in `ReadUpload`.
   */
  @GrpcMethod('UploadsService', 'DescribeUploads')
  async describeUploads(req: DescribeUploadsWire, metadata: Metadata) {
    const actor = readUploadActor(metadata);
    const ids = readIds(req?.uploadIds);
    if (ids.length === 0) return { uploads: [] };
    const rows = await this.uploads.describe(actor.accountId, ids);
    return {
      uploads: rows.filter((r) => mayDescribe(actor, r)).map(toUploadWire),
    };
  }
}

function mayDescribe(
  actor: ReturnType<typeof readUploadActor>,
  row: UploadRow,
): boolean {
  try {
    assertPurposePermission(actor, row.purpose);
    return true;
  } catch {
    return false;
  }
}
