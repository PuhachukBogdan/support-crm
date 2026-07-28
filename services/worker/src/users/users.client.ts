import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { USERS_PACKAGE, USERS_PROTO, grpcClientOptions } from '@crm/common';

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

export interface PurgeResult {
  purged: number;
  objectMissing: number;
  failed: number;
}

interface UsersMaintenanceGrpc {
  purgeExpiredArtefacts(data: { limit: number }, md?: Metadata): Observable<PurgeResult>;
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
    ]),
  ],
  providers: [UsersMaintenanceClient],
  exports: [UsersMaintenanceClient],
})
export class WorkerUsersModule {}
