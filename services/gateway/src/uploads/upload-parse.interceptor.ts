import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { purposeOf } from '@crm/common';
import type { Observable } from 'rxjs';

/**
 * Multipart parsing for `POST /uploads/:purpose`, with the size limit resolved FROM THE PATH BEFORE
 * PARSING BEGINS (feature 016 — FR-007 / research R3).
 *
 * ── Why the limit cannot be a decorator argument ─────────────────────────────────────────────────
 * `@UseInterceptors(FileInterceptor('file', { limits }))` fixes its options at decoration time, and
 * the cap here is per purpose: 10 MB for an attachment, 2 MB for an avatar. A single decorator would
 * have to use the largest, which would silently let a 10 MB avatar through the edge and only refuse
 * it deeper in — after the server had already accepted every byte. That is precisely the failure
 * FR-007 names.
 *
 * ── Why the purpose is in the PATH ───────────────────────────────────────────────────────────────
 * A `purpose` field inside the multipart body is only guaranteed to arrive before the file part if
 * the client orders it that way. Taking it from the path removes the ordering dependency entirely.
 *
 * ── Why it delegates to Nest's FileInterceptor ───────────────────────────────────────────────────
 * Constructing the mixin per request gives a per-request limit while keeping `multer` out of the
 * gateway's direct imports — it stays an implementation detail of `@nestjs/platform-express`. That
 * also keeps the structural scan honest: the only multipart handling in the gateway is here, in
 * `src/uploads/`.
 *
 */
@Injectable()
export class UploadParseInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<{ params?: Record<string, string> }>();
    const purpose = purposeOf(req.params?.purpose);
    // Refused BEFORE a single byte is parsed. 404 rather than 403: the catalogue is closed, so an
    // unknown purpose is a wrong URL, not a permission problem (the guard has already run and made
    // the same call).
    if (!purpose) throw new NotFoundException();

    // No `storage` and no `dest` → multer keeps the file IN MEMORY. That is its documented default
    // (`node_modules/multer/index.js`: storage → dest → memoryStorage) and it is the behaviour we
    // want: bytes must never touch the gateway's disk, since the gateway is not where they live.
    // `memoryStorage` is not re-exported by `@nestjs/platform-express`, and importing it from
    // `multer` directly would declare a second copy of a package the gateway deliberately does not
    // depend on — the "gateway gains nothing" property from research R2 is partly a dependency-list
    // property.
    //
    // `limits.files: 1` matters as much as `fileSize`: without it a client can send a thousand small
    // parts and stay under every byte cap.
    const Mixin = FileInterceptor('file', {
      limits: { fileSize: purpose.maxBytes, files: 1, fields: 4, parts: 6 },
    });

    let delegate: NestInterceptor;
    try {
      delegate = new (Mixin as new () => NestInterceptor)();
    } catch {
      throw new BadRequestException('upload not accepted');
    }

    try {
      return (await delegate.intercept(context, next)) as Observable<unknown>;
    } catch (err) {
      throw toHttpError(err);
    }
  }
}

/**
 * Multer failures → HTTP, without echoing anything the client sent.
 *
 * A multer error carries `field` and can carry the original filename; a filename can itself be PII
 * (`john_smith_passport.jpg`), so nothing from the error is forwarded — only its CODE is consulted
 * (FR-020 / SEC-26). This is the failure path, and SC-007 covers the failure paths as well as the
 * happy one.
 */
function toHttpError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  const code = (err as { code?: string })?.code;
  switch (code) {
    case 'LIMIT_FILE_SIZE':
      // 413. The request was aborted mid-stream — the server did not take the whole file.
      return new HttpException('file too large', 413);
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_PART_COUNT':
    case 'LIMIT_FIELD_COUNT':
      return new BadRequestException('too many parts');
    case 'LIMIT_UNEXPECTED_FILE':
      return new BadRequestException('unexpected field');
    default:
      return new BadRequestException('malformed upload');
  }
}
