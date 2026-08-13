import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import {
  USERS_PACKAGE,
  USERS_PROTO,
  UPLOAD_CLIENT_CHANNEL_OPTIONS,
  grpcClientOptions,
} from '@crm/common';

/**
 * worker → users maintenance client (feature 017, roadmap 4.10 / research R8).
 *
 * The worker's role here is the same as its role in the SLA sweep: **scheduling**. It fires a tick and
 * asks `users` to purge what has expired. It holds no artefact state, knows no expiry, reads no
 * database (it has none), and never sees a byte — `users` owns the storage credentials and therefore
 * owns the deletion. That split is why this client has exactly one method.
 *
 * `x-actor-kind: system` marks the caller as not-a-user. The maintenance RPC refuses anything else and
 * the gateway exposes no route to it, so this is the only way in.
 *
 * ⚠️ This is the ONE path in the product that removes stored bytes, and it deliberately supersedes
 * feature 016's "nothing in v1 removes bytes" for a single purpose class (`ephemeral`). An artefact
 * whose defining property is that it EXPIRES cannot honour that rule, and a status flag saying
 * "expired" while the bytes sit in a bucket is SEC-27 rather than a fix for it.
 */
export const WORKER_USERS_CLIENT = 'WORKER_USERS_CLIENT';

/**
 * ⭐ Feature 033 (roadmap 6.4): a SECOND channel to the same service, for the one call that carries bytes.
 *
 * Separate because the message-size ceiling differs and nothing else does. The maintenance channel below
 * deliberately keeps the default ceiling — *"this call carries a LIMIT and returns COUNTS"* — and raising
 * it there would tie a counts-only tick's limits to whatever the byte path needs next. That is the same
 * split `chats` already makes between `ChatsUploadsModule` and `ChatsPersonModule`.
 */
export const WORKER_USERS_UPLOADS_CLIENT = 'WORKER_USERS_UPLOADS_CLIENT';

export interface PurgeResult {
  purged: number;
  objectMissing: number;
  failed: number;
}

/** Counts only, like every maintenance answer (feature 025, roadmap 5.9). */
export interface SweepPresenceResult {
  toAway: number;
  toOffline: number;
  failed: number;
}

/** Feature 033: the one byte-carrying call this service makes. See `UsersUploadsClient` below. */
interface UploadsGrpc {
  createUpload(
    d: { purpose: string; declaredContentType: string; filename: string; content: Buffer },
    md?: Metadata,
  ): Observable<{ id?: string }>;
}

/** ⭐ W31 / feature 038: the operator half of an offboarding. */
export interface SetOperatorActiveResult {
  changed: boolean;
  /** The `users.Operator.id` — the id CHATS knows an assignee by. Empty when there is no row. */
  operatorId: string;
}

interface UsersMaintenanceGrpc {
  purgeExpiredArtefacts(data: { limit: number }, md?: Metadata): Observable<PurgeResult>;
  sweepIdlePresence(data: { limit: number }, md?: Metadata): Observable<SweepPresenceResult>;
  setOperatorActive(
    data: { authUserId: string; active: boolean },
    md?: Metadata,
  ): Observable<{ changed?: boolean; operatorId?: string }>;
}

@Injectable()
export class UsersMaintenanceClient implements OnModuleInit {
  private svc!: UsersMaintenanceGrpc;

  constructor(@Inject(WORKER_USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<UsersMaintenanceGrpc>('UsersMaintenanceService');
  }

  /** Purge one batch. Returns counts only — no ids, no filenames, no tenant data (SEC-26). */
  async purgeExpiredArtefacts(limit: number): Promise<PurgeResult> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    return firstValueFrom(this.svc.purgeExpiredArtefacts({ limit }, md));
  }

  /**
   * Lower the availability of operators whose session has gone quiet (feature 025, roadmap 5.9).
   *
   * The worker's role is the same as everywhere else here: a **tick**. It holds no thresholds, no
   * presence state and no clock authority — `users` owns all three, reads them from its own
   * refuse-to-start config, and decides. The worker only says "now".
   *
   * `x-actor-kind: system` is the whole authorization: the rpc refuses anything else and the gateway
   * exposes no route to it. That matters more here than for the purge — a sweep reachable from a
   * session would be a way to put a colleague offline without holding `users.presence.manage`.
   */
  async sweepIdlePresence(limit: number): Promise<SweepPresenceResult> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    return firstValueFrom(this.svc.sweepIdlePresence({ limit }, md));
  }

  /**
   * ⭐ W31 / feature 038 (ADR 0043 §3): take a departed colleague out of every routing pool.
   *
   * ⚠️ **The account travels in the METADATA**, unlike the two ticks above, because this call names a
   * person rather than sweeping a batch — and `users` composes that account into the query itself.
   * The sweep learns it from auth's own answer; a machine has no account of its own to default to.
   *
   * ⓘ `NOT_FOUND` is a real and ordinary answer: plenty of accounts belong to nobody who ever took a
   * conversation. The caller treats it as «nothing to do here», never as a failed offboarding.
   */
  async setOperatorActive(
    accountId: string,
    authUserId: string,
    active: boolean,
  ): Promise<SetOperatorActiveResult | null> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    md.set('x-actor-account-id', accountId);
    try {
      const res = await firstValueFrom(this.svc.setOperatorActive({ authUserId, active }, md));
      return { changed: res.changed === true, operatorId: String(res.operatorId ?? '') };
    } catch (e) {
      if ((e as { code?: number })?.code === GrpcStatus.NOT_FOUND) return null;
      throw e;
    }
  }
}

/**
 * ⭐ The customer's attachment, stored through the ONE ingest path (feature 033 — FR-035, research R12).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THE WORKER UPLOADS, AND THAT IS THE SHORTER ROUTE RATHER THAN A WORKAROUND.**
 *
 * The first draft of this feature carried attachment bytes to `chats` on the intake rpc.
 * `tests/uploads/single-ingest-path.spec.ts` refused it: feature 016 pins the complete set of
 * `bytes`-carrying proto messages, so that raw content enters the product by exactly one path. The guard
 * did not merely block a contract — it pointed at the better design. The worker already holds a `users`
 * client, so the bytes travel ONE hop instead of two, `chats` never buffers a stranger's file in memory,
 * and the validation that decides whether a file is acceptable happens in the service that owns storage.
 *
 * ⚠️ **A refused file must not lose the message** (FR-018). This method reports a per-file verdict rather
 * than throwing for the batch: silently dropping a customer's words because of a bad screenshot is
 * indistinguishable from the product working.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class UsersUploadsClient implements OnModuleInit {
  private uploads!: UploadsGrpc;

  constructor(@Inject(WORKER_USERS_UPLOADS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.uploads = this.client.getService<UploadsGrpc>('UploadsService');
  }

  /**
   * Store one inbound file under the `channel_inbound_attachment` purpose.
   *
   * @param accountId whose account it belongs to — resolved from `chats` by channel key, never configured
   *        (see `ChatsMaintenanceClient.resolveIntakeChannel`).
   * @returns the upload id, or `null` when `users` refused the file (wrong type, too large, unreadable).
   *
   * ⚠️ **Nothing about the file is logged**: a filename can itself be PII (feature 016's FR-020), and a
   * refusal reason from `users` can quote it. The caller counts refusals; it never names one.
   */
  async storeInbound(
    accountId: string,
    file: { filename: string; declaredContentType: string; content: Buffer },
  ): Promise<string | null> {
    // The purpose's `permission` is null — "authenticated is sufficient" — but `users` still refuses
    // without an ACCOUNT, which is what makes this a scoped write rather than an anonymous one. No
    // `x-actor-user-id`: there is no user, and inventing one would attribute a customer's file to a
    // member of staff.
    const md = new Metadata();
    md.set('x-actor-account-id', accountId);
    md.set('x-actor-kind', 'system');

    try {
      const res = await firstValueFrom(
        this.uploads.createUpload(
          {
            purpose: 'channel_inbound_attachment',
            declaredContentType: file.declaredContentType,
            filename: file.filename,
            content: file.content,
          },
          md,
        ),
      );
      return typeof res?.id === 'string' && res.id !== '' ? res.id : null;
    } catch {
      // Refused or unreachable — both mean this file does not travel, and neither may stop the message.
      return null;
    }
  }
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: WORKER_USERS_CLIENT,
        useFactory: () =>
          // No raised message ceiling here on purpose: this call carries a LIMIT and returns COUNTS.
          // The 12 MB uploads channel exists for the paths that move files, and this is not one — the
          // bytes are deleted inside `users`, never streamed anywhere.
          grpcClientOptions(USERS_PACKAGE, USERS_PROTO, process.env.USERS_GRPC_TARGET as string),
      },
      {
        name: WORKER_USERS_UPLOADS_CLIENT,
        useFactory: () =>
          // Feature 033: the raised ceiling, and the ONLY channel out of this service that carries bytes.
          grpcClientOptions(
            USERS_PACKAGE,
            USERS_PROTO,
            process.env.USERS_GRPC_TARGET as string,
            UPLOAD_CLIENT_CHANNEL_OPTIONS,
          ),
      },
    ]),
  ],
  providers: [UsersMaintenanceClient, UsersUploadsClient],
  exports: [UsersMaintenanceClient, UsersUploadsClient],
})
export class WorkerUsersModule {}
