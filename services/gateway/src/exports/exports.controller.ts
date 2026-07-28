import {
  Controller,
  Get,
  HttpCode,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request, Response } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT, USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import {
  RequiresScopePermission,
  ResolvesPermissions,
} from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callUploads } from '../uploads/rpc';
import { sendUpload } from '../uploads/serve';
import { parseExportFilters, parsePageSize } from './wire';

interface ExportJobWire {
  id: string;
  scope: string;
  format: string;
  status: string;
  rowCount: number;
  byteSize: string;
  failureReason: string;
  expiresAt: string;
  createdAt: string;
  completedAt: string;
}
interface ExportListWire {
  exports?: ExportJobWire[];
  nextCursor?: string;
}
interface ArtefactRefWire {
  uploadId: string;
  displayName: string;
}
interface ExportsGrpc {
  createExport(d: Record<string, unknown>, md?: unknown): Observable<ExportJobWire>;
  listExports(d: Record<string, unknown>, md?: unknown): Observable<ExportListWire>;
  getExport(d: Record<string, unknown>, md?: unknown): Observable<ExportJobWire>;
  resolveExportArtefact(d: Record<string, unknown>, md?: unknown): Observable<ArtefactRefWire>;
}
interface UploadContentWire {
  contentType: string;
  displayName: string;
  inlineSafe: boolean;
  content: Uint8Array | Buffer;
}
interface UploadsGrpc {
  readUpload(d: Record<string, unknown>, md?: unknown): Observable<UploadContentWire>;
}

type ExportReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * The exports REST edge (feature 017, roadmap 4.10 — SEC-21/SEC-22/SEC-27).
 *
 * ── Nothing here is a link ───────────────────────────────────────────────────────────────────────
 * `POST` returns a record. `GET /:id` returns a status. The download resolves the export to an upload
 * id inside `chats` and then fetches the bytes through the EXISTING brokered `ReadUpload`, which
 * re-authorizes against the caller's CURRENT account and permissions. No presigned or tokenized URL is
 * issued anywhere in this feature — a signed link moves the decision to link-creation time, which IS the
 * SEC-10/SEC-27 defect.
 *
 * ── Every route carries permission metadata, including the GETs ──────────────────────────────────
 * ⚠️ This is not decoration: the guard populates `req.effective` only for routes carrying permission
 * metadata, and `buildActorMetadata` reads exactly that to fill `x-actor-permissions`. Feature 016's
 * Track B found this the hard way — its two GET routes carried none, forwarded an EMPTY permission set,
 * and `users` correctly refused every read. A 403 on a file the caller owned. Both tiers were right; the
 * wire between them was not.
 */
@Controller('exports')
export class ExportsController implements OnModuleInit {
  private exports!: ExportsGrpc;
  private uploads!: UploadsGrpc;

  constructor(
    @Inject(CHATS_CLIENT) private readonly chats: ClientGrpc,
    @Inject(USERS_CLIENT) private readonly users: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.exports = this.chats.getService<ExportsGrpc>('ChatsExportService');
    this.uploads = this.users.getService<UploadsGrpc>('UploadsService');
  }

  private meta(req: ExportReq) {
    return buildActorMetadata(req.claims!, req.effective?.permissionKeys ?? []);
  }

  /**
   * Request an export.
   *
   * **202, not 201**, and deliberately: nothing exists yet that the caller can consume. A `201 Created`
   * with a `Location` pointing at bytes that do not exist invites a client to fetch immediately and read
   * the 409 as an error.
   *
   * The scope is a PATH parameter so `@RequiresScopePermission` can resolve the required key before the
   * body is parsed — a static decorator string cannot express a parameter-dependent key, which is the
   * CRITICAL feature 016's `/analyze` found (the gateway tier would silently enforce nothing).
   */
  @Post(':scope')
  @HttpCode(202)
  @RequiresScopePermission('scope')
  async create(
    @Param('scope') scope: string,
    @Req() req: ExportReq,
  ): Promise<ExportJobWire> {
    // Fail-closed parsing: an unrecognised filter is a 400, never dropped and never widened. Feature
    // 012's live defect was an unknown value silently coerced to a default.
    const filters = parseExportFilters(req.body as unknown);
    return callUploads(this.exports.createExport({ scope, filters }, this.meta(req)));
  }

  /** The caller's OWN exports. There is no "team exports" concept in v1. */
  @Get()
  @ResolvesPermissions()
  async list(
    @Query('pageSize') pageSize: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Req() req: ExportReq,
  ): Promise<ExportListWire> {
    return callUploads(
      this.exports.listExports(
        { pageSize: parsePageSize(pageSize), cursor: cursor ?? '' },
        this.meta(req),
      ),
    );
  }

  /**
   * One export's status.
   *
   * 404 for all of: unknown id, another account's id, a same-account non-owner's id. `expired` is
   * visible only on the caller's OWN record — and an expired export's ARTEFACT is 404 rather than 410,
   * because confirming that something existed is an existence oracle for an object that is gone.
   */
  @Get(':id')
  @ResolvesPermissions()
  async get(@Param('id') id: string, @Req() req: ExportReq): Promise<ExportJobWire> {
    return callUploads(this.exports.getExport({ exportId: id }, this.meta(req)));
  }

  /**
   * The bytes — the only route in this feature that moves any.
   *
   * Two hops, and the second one is the guarantee: `chats` checks ownership, readiness and expiry, then
   * `users` re-authorizes the read at fetch time. A requester who lost the scope's permission between
   * asking and downloading is refused HERE, with no change to the stored record.
   *
   * The response posture is the one feature 016 built — one place, so a new route cannot serve a file
   * with weaker headers by forgetting one. A CSV is not `inlineSafe`, so it is always an attachment.
   */
  @Get(':id/download')
  @ResolvesPermissions()
  async download(
    @Param('id') id: string,
    @Req() req: ExportReq,
    @Res() res: Response,
  ): Promise<void> {
    const md = this.meta(req);
    const ref = await callUploads(this.exports.resolveExportArtefact({ exportId: id }, md));
    const content = await callUploads(
      this.uploads.readUpload({ uploadId: ref.uploadId, variant: 'UPLOAD_VARIANT_ORIGINAL' }, md),
    );

    sendUpload(
      res,
      {
        contentType: content.contentType,
        // The label from `chats` (scope + date). Never a filter value, and never logged (SEC-26).
        displayName: ref.displayName || content.displayName,
        // Never inline for an export: a bulk data file has nothing to gain from rendering in a tab.
        inlineSafe: false,
        // `false` ⇒ `private, no-store`. A bulk PII payload must not sit in a disk cache outliving both
        // the expiry and the purge, which would quietly defeat FR-013.
        isDerivative: false,
      },
      content.content,
    );
  }
}
