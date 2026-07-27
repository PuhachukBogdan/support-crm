import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import {
  USERS_PACKAGE,
  USERS_PROTO,
  UPLOAD_CLIENT_CHANNEL_OPTIONS,
  grpcClientOptions,
} from '@crm/common';
import type { Metadata } from '@grpc/grpc-js';

/**
 * chats → users: claim uploads and read their metadata (feature 016, research R8).
 *
 * The second cross-service edge out of chats, modelled on the auth client feature 014 introduced.
 * Acyclic: users never calls chats.
 *
 * ── Why chats does not own uploads ───────────────────────────────────────────────────────────────
 * The second consumer is the profile avatar (8.10), which has nothing to do with conversations.
 * Owning uploads here would make every avatar read a chats call (research R1). So chats holds a SOFT
 * `upload_id` and validates it over this edge — never a cross-database join (Principle VIII).
 *
 * ── Fail-closed (FR-015) ─────────────────────────────────────────────────────────────────────────
 * Users unreachable, a refused claim, or a response we cannot read ⇒ the caller REFUSES the message.
 * A message posted without the attachment its author selected is not a degraded success: the agent
 * believes the customer received a file that was never linked to anything.
 */

export const CHATS_UPLOADS_CLIENT = 'CHATS_UPLOADS_CLIENT';

/** The uploads service could not be consulted. Callers must refuse, never assume. */
export class UploadsUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`uploads unavailable: ${detail}`);
    this.name = 'UploadsUnavailableError';
  }
}

/** Rendering metadata for one upload. No bytes ever cross this edge. */
export interface UploadDescription {
  uploadId: string;
  contentType: string;
  byteSize: number;
  displayName: string;
  hasDerivative: boolean;
}

interface UploadWire {
  id?: string;
  contentType?: string;
  byteSize?: number | string;
  displayName?: string;
  hasDerivative?: boolean;
}

interface UploadsGrpc {
  claimUploads(
    d: { uploadIds: string[]; claimedBy: string },
    md?: Metadata,
  ): Observable<{ uploadIds?: string[] }>;
  describeUploads(
    d: { uploadIds: string[] },
    md?: Metadata,
  ): Observable<{ uploads?: UploadWire[] }>;
}

@Injectable()
export class UploadsClient implements OnModuleInit {
  private uploads!: UploadsGrpc;

  constructor(@Inject(CHATS_UPLOADS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.uploads = this.client.getService<UploadsGrpc>('UploadsService');
  }

  /**
   * Claim `uploadIds` before the referencing row is written.
   *
   * The caller's own metadata is forwarded unchanged, so `users` evaluates the purpose's permission
   * against the REAL actor — chats never claims on its own authority. A rethrown `RpcException` from
   * users (refused claim) is passed through so the caller maps it to the right status; only a
   * TRANSPORT failure becomes {@link UploadsUnavailableError}.
   */
  async claim(
    _accountId: string,
    uploadIds: string[],
    metadata: Metadata,
    claimedBy = 'chats:message',
  ): Promise<string[]> {
    let res: { uploadIds?: string[] };
    try {
      res = await firstValueFrom(this.uploads.claimUploads({ uploadIds, claimedBy }, metadata));
    } catch (err) {
      // A refusal from users carries a gRPC status code; anything else is the transport being down.
      if (typeof (err as { code?: number })?.code === 'number') throw err;
      // Reason CLASS only — never an id, never a response body (Principle IV / SEC-26).
      throw new UploadsUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }
    if (!Array.isArray(res?.uploadIds)) throw new UploadsUnavailableError('unreadable response');
    return res.uploadIds;
  }

  /**
   * Metadata for a capped set of ids — ONE call per thread page, never one per message
   * (Principle VII, no N+1).
   *
   * The values are deliberately NOT denormalized into chats_db. That keeps the PII-capable
   * `display_name` in exactly one database, so "where can a filename be" has one answer.
   */
  async describe(uploadIds: string[], metadata: Metadata): Promise<UploadDescription[]> {
    if (uploadIds.length === 0) return [];
    let res: { uploads?: UploadWire[] };
    try {
      res = await firstValueFrom(this.uploads.describeUploads({ uploadIds }, metadata));
    } catch (err) {
      if (typeof (err as { code?: number })?.code === 'number') throw err;
      throw new UploadsUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }
    const rows = res?.uploads;
    if (!Array.isArray(rows)) throw new UploadsUnavailableError('unreadable response');
    return rows.map((u) => ({
      uploadId: u.id ?? '',
      contentType: u.contentType ?? '',
      byteSize: Number(u.byteSize ?? 0),
      displayName: u.displayName ?? '',
      hasDerivative: !!u.hasDerivative,
    }));
  }
}

/**
 * Registers the users client for chats.
 *
 * `USERS_GRPC_TARGET` is a BOOT requirement (see `config.ts`): chats had only `AUTH_GRPC_TARGET`
 * before this feature, and its config guard is refuse-to-start, so omitting the new key is a boot
 * failure rather than a runtime fallback. The channel ceiling is raised for symmetry with the users
 * server even though no bytes cross this edge — a mismatched pair is a class of bug worth not having.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CHATS_UPLOADS_CLIENT,
        useFactory: () =>
          grpcClientOptions(
            USERS_PACKAGE,
            USERS_PROTO,
            process.env.USERS_GRPC_TARGET as string,
            UPLOAD_CLIENT_CHANNEL_OPTIONS,
          ),
      },
    ]),
  ],
  providers: [UploadsClient],
  exports: [UploadsClient],
})
export class ChatsUploadsModule {}
