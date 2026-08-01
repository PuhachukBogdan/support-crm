import { Controller, Get, Inject, OnModuleInit, Param, Query, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface ConversationPageWire {
  conversations: unknown[];
  nextPageToken: string;
}

interface ChatsReadGrpc {
  getPersonFeed(d: Record<string, unknown>, md?: unknown): Observable<ConversationPageWire>;
  getPersonContactSummary(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Person-level REST edge (feature 022, roadmap 4.13 — implementing what feature 020 declared).
 *
 *   GET /persons/:personId/feed             → the conversations of one HUMAN, across linked brands
 *   GET /persons/:personId/contact-summary  → the same contact facts, aggregated over their records
 *
 * ── Why these routes did not exist before ───────────────────────────────────────────────────────
 * `ChatsReadService.GetPersonFeed` was declared by feature 020 and served by nothing — no handler here,
 * no handler there, no test anywhere — while `users.ListPersonMembers` waited on the other side with no
 * caller. Both halves are built now, and `tests/contracts/every-rpc-is-served.spec.ts` makes the gap
 * impossible to reintroduce silently.
 *
 * ── A thin proxy, and it must STAY thin (Principle VIII / FR-032) ───────────────────────────────
 * The gateway resolves permissions and forwards; it does not resolve membership and does not aggregate.
 * `chats` owns the conversations, so `chats` does the union — a gateway that fetched members and then
 * called per member would be business logic at the edge AND an N+1 across services.
 * `person.spec.ts` asserts both structurally.
 *
 * ── Two permissions, and the second one is not checked here ─────────────────────────────────────
 * `crm.inbox.view` is declared on these routes (which is also what makes the guard populate
 * `req.effective`, so the actor's permissions actually reach the service — feature 016's live-only
 * defect). The person level ALSO requires `crm.contact.view`, and that is enforced by `users` on the
 * forwarded credentials when membership is resolved: knowing that two records are one person is a
 * statement about a customer. Re-checking it here would be a second enforcement point that can drift from
 * the first — and checking it ONLY here would be worse, because a direct gRPC caller would bypass it.
 */
@Controller('persons/:personId')
export class PersonController implements OnModuleInit {
  private read!: ChatsReadGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<ChatsReadGrpc>('ChatsReadService');
  }

  @Get('feed')
  @RequiresPermission('crm.inbox.view')
  async feed(
    @Param('personId') personId: string,
    @Query() q: { pageToken?: string; pageSize?: string },
    @Req() req: ChatsReq,
  ) {
    const md = buildActorMetadata(req.claims!, req.effective);
    return callChats(
      this.read.getPersonFeed(
        {
          personId,
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        md,
      ),
    );
  }

  @Get('contact-summary')
  @RequiresPermission('crm.inbox.view')
  async contactSummary(@Param('personId') personId: string, @Req() req: ChatsReq) {
    const md = buildActorMetadata(req.claims!, req.effective);
    return callChats(this.read.getPersonContactSummary({ personId }, md));
  }
}
