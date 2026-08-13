import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_PACKAGE, AUTH_PROTO, grpcClientOptions } from '@crm/common';

/**
 * worker → auth mail client (feature 028, roadmap mail delivery / research R2).
 *
 * The worker's role here is the same as in every other tick: **scheduling**. It says "now"; auth
 * holds the outbox, renders the message and opens the SMTP connection.
 *
 * ⚠️ **The alternative was to move the send here, and that was rejected on purpose.** It would have
 * put a LIVE ONE-TIME CODE into a gRPC payload and into this process's memory and failure paths.
 * The promise that the code appears in no log on any path is cheapest to keep by shrinking the
 * number of places the code exists — so this client sends a number and receives three.
 */
export const WORKER_AUTH_CLIENT = 'WORKER_AUTH_CLIENT';

/** Counts only, like every maintenance answer in this service. */
export interface SendDueEmailsResult {
  attempted: number;
  sent: number;
  failed: number;
}

interface AuthMailGrpc {
  sendDueEmails(data: { batch: number }): Observable<SendDueEmailsResult>;
}

/** ⭐ W31 / feature 038: one closed account the sweep must finish propagating. */
export interface DisabledStaffMember {
  accountId: string;
  userId: string;
}

interface AuthMaintenanceGrpc {
  listDisabledStaff(
    data: { limit: number; withinDays: number },
    md?: Metadata,
  ): Observable<{ staff?: { accountId?: string; userId?: string }[] }>;
}

/**
 * ⭐ W31 / feature 038 (ADR 0043 §3/§4): the offboarding sweep's first question.
 *
 * A separate client from the mail one above because it speaks to a different gRPC service on the
 * same host — `AuthMaintenanceService`, which is system-actor gated and has no gateway route.
 */
@Injectable()
export class AuthStaffClient implements OnModuleInit {
  private svc!: AuthMaintenanceGrpc;

  constructor(@Inject(WORKER_AUTH_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<AuthMaintenanceGrpc>('AuthMaintenanceService');
  }

  /**
   * Who has been offboarded lately.
   *
   * ⚠️ Identifiers only — no email, no name. This list crosses a service boundary every tick, and a
   * name on it would put «who left the company recently» into the worker's memory and failure paths
   * for no purpose: the two follow-up calls address people by id.
   */
  async listDisabledStaff(limit: number, withinDays: number): Promise<DisabledStaffMember[]> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');
    const res = await firstValueFrom(this.svc.listDisabledStaff({ limit, withinDays }, md));
    return (res.staff ?? [])
      .map((s) => ({ accountId: String(s.accountId ?? ''), userId: String(s.userId ?? '') }))
      .filter((s) => s.accountId !== '' && s.userId !== '');
  }
}

@Injectable()
export class AuthMailClient implements OnModuleInit {
  private svc!: AuthMailGrpc;

  constructor(@Inject(WORKER_AUTH_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.svc = this.client.getService<AuthMailGrpc>('AuthService');
  }

  /**
   * Ask auth to attempt one batch of due messages.
   *
   * ⓘ Numbers arrive from proto-loader as numbers here because the fields are `int32`, not `int64`
   * — the string-encoding trap that bit features 009 and 025 applies to longs, and this rpc
   * deliberately has none.
   */
  async sendDueEmails(batch: number): Promise<SendDueEmailsResult> {
    const res = await firstValueFrom(this.svc.sendDueEmails({ batch }));
    return {
      attempted: Number(res.attempted ?? 0),
      sent: Number(res.sent ?? 0),
      failed: Number(res.failed ?? 0),
    };
  }
}

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: WORKER_AUTH_CLIENT,
        useFactory: () =>
          grpcClientOptions(AUTH_PACKAGE, AUTH_PROTO, process.env.AUTH_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [AuthMailClient, AuthStaffClient],
  exports: [AuthMailClient, AuthStaffClient],
})
export class WorkerAuthModule {}
