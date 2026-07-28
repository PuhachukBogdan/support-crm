import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request, Response } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import {
  RequiresPurposePermission,
  ResolvesPermissions,
} from '../security/requires-permission.decorator';
// The gateway's actor-metadata builder. It lives under `chats/` because feature 012 needed it
// first; it is not chats-specific, and duplicating it here would be a second copy of the identity
// contract every service-tier guard reads.
import { buildActorMetadata } from '../chats/actor-metadata';
import { UploadParseInterceptor } from './upload-parse.interceptor';
import { callUploads } from './rpc';
import { sendUpload } from './serve';

/**
 * The upload REST edge (feature 016, roadmap 4.9 — SEC-1).
 *
 * ⚠️ THIS IS THE ONLY PLACE IN THE PRODUCT THAT ACCEPTS A BYTE STREAM, and
 * `tests/uploads/single-ingest-path.spec.ts` fails the build if a second one appears. SEC-1 was not
 * "an upload endpoint had a broken auth check" — it was "there were TWO upload endpoints, and the
 * second one's own check passed for an anonymous request". Hardening one path leaves that class of
 * defect intact, so the requirement is singular: one path exists, and a second cannot be added
 * without a test failing.
 *
 * The gateway proxies bytes and makes NO validation decision and holds NO storage credentials
 * (research R2). That absence is the observable form of credential containment — visible in the
 * config schema, not just in prose.
 *
 * Authentication is the global AuthGuard (no `@Public()` here, and the public-allow-list spec
 * asserts the absence). Authorization is `@RequiresPurposePermission`, which resolves the required
 * key from the closed purpose catalogue at request time; `users` re-checks it independently.
 */

interface UploadWire {
  id: string;
}
interface UploadContentWire {
  contentType: string;
  displayName: string;
  inlineSafe: boolean;
  content: Uint8Array | Buffer;
}
interface UploadsGrpc {
  createUpload(d: Record<string, unknown>, md?: unknown): Observable<UploadWire>;
  readUpload(d: Record<string, unknown>, md?: unknown): Observable<UploadContentWire>;
}

type UploadReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

@Controller('uploads')
export class UploadsController implements OnModuleInit {
  private uploads!: UploadsGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.uploads = this.client.getService<UploadsGrpc>('UploadsService');
  }

  private meta(req: UploadReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  @Post(':purpose')
  @RequiresPurposePermission('purpose')
  @UseInterceptors(UploadParseInterceptor)
  async create(
    @Param('purpose') purpose: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: UploadReq,
  ) {
    if (!file || !file.buffer || file.buffer.byteLength === 0) {
      throw new BadRequestException('no file');
    }
    return callUploads(
      this.uploads.createUpload(
        {
          purpose,
          // Passed through so `users` can compare it against the detected type and then discard it.
          // Never trusted, never stored — a stored declared-type looks authoritative and is not.
          declaredContentType: file.mimetype ?? '',
          // Sanitised in `users` into a display label. The gateway does not log it (FR-020).
          filename: file.originalname ?? '',
          content: file.buffer,
        },
        this.meta(req),
      ),
    );
  }

  /**
   * The original.
   *
   * The required key depends on the upload's PURPOSE, which is known only from the stored row — so
   * unlike `POST /uploads/:purpose` there is no path parameter the gateway can resolve it from, and
   * the authorization decision belongs entirely to `users` (FR-010).
   *
   * ⚠️ `@ResolvesPermissions()` is NOT optional here, and its absence was a real defect found by this
   * feature's own Track B run. The guard populates `req.effective` only for routes carrying
   * permission metadata, and `buildActorMetadata` reads exactly that to fill `x-actor-permissions`.
   * Without the decorator this route forwarded an EMPTY permission set and `users` correctly refused
   * every read — a 403 on a file the caller owned. Both tiers were individually right; the wire
   * between them was not, which is precisely the class of defect a live run exists to catch.
   */
  @Get(':id')
  @ResolvesPermissions()
  async read(@Param('id') id: string, @Req() req: UploadReq, @Res() res: Response): Promise<void> {
    await this.serveVariant(id, 'UPLOAD_VARIANT_ORIGINAL', false, req, res);
  }

  /**
   * The derivative — the small re-encoded copy lists are served (Principle VII).
   *
   * A purpose that produces none answers 404 rather than falling back to the original: a fallback
   * would hand a caller expecting a thumbnail a full-size file it will render as one.
   */
  @Get(':id/thumb')
  @ResolvesPermissions()
  async thumb(@Param('id') id: string, @Req() req: UploadReq, @Res() res: Response): Promise<void> {
    await this.serveVariant(id, 'UPLOAD_VARIANT_DERIVATIVE', true, req, res);
  }

  private async serveVariant(
    uploadId: string,
    variant: string,
    isDerivative: boolean,
    req: UploadReq,
    res: Response,
  ): Promise<void> {
    // `callUploads` maps a downstream NOT_FOUND to a 404 rather than letting the raw gRPC error
    // escape as a 500 with a stack — the defect feature 012's Track B found, pre-empted here (T049).
    const content = await callUploads(
      this.uploads.readUpload({ uploadId, variant }, this.meta(req)),
    );
    sendUpload(
      res,
      {
        contentType: content.contentType,
        displayName: content.displayName ?? '',
        inlineSafe: !!content.inlineSafe,
        isDerivative,
      },
      content.content instanceof Uint8Array ? content.content : Uint8Array.from(content.content),
    );
  }
}
