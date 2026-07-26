import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { CHATS_PACKAGE, CHATS_PROTO, grpcClientOptions } from '@crm/common';

/**
 * worker → chats maintenance client (feature 014, roadmap 4.7 / research R2).
 *
 * The worker's whole role in the SLA is **scheduling**: fire a tick, ask chats to sweep. It holds no
 * rule state, reads no database (it has none) and makes no decisions about what counts as a breach —
 * chats owns the data and the verdict. That split is why this client has exactly one method.
 *
 * `x-actor-kind: system` marks the caller as not-a-user. The maintenance RPC refuses anything else, and
 * the gateway exposes no route to it, so this is the only way in.
 */
export const WORKER_CHATS_CLIENT = 'WORKER_CHATS_CLIENT';

export interface SweepResult {
  checked: number;
  breached: number;
  rulesApplied: number;
}

interface MaintenanceGrpc {
  sweepFirstReplySla(data: { limit: number }, md?: Metadata): Observable<SweepResult>;
}

@Injectable()
export class ChatsMaintenanceClient implements OnModuleInit {
  private svc!: MaintenanceGrpc;

  constructor(@Inject(WORKER_CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<MaintenanceGrpc>('ChatsMaintenanceService');
  }

  /** Run one sweep. Returns counts only — no tenant data crosses this boundary (research R3). */
  async sweepFirstReplySla(limit: number): Promise<SweepResult> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    return firstValueFrom(this.svc.sweepFirstReplySla({ limit }, md));
  }
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: WORKER_CHATS_CLIENT,
        useFactory: () =>
          grpcClientOptions(CHATS_PACKAGE, CHATS_PROTO, process.env.CHATS_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [ChatsMaintenanceClient],
  exports: [ChatsMaintenanceClient],
})
export class WorkerChatsModule {}
