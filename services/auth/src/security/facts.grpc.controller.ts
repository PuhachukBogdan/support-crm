import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { AuthAccessGuard } from './permission.guard';
import { RequiresAuthPermission } from './requires-auth-permission.decorator';
import { readActorContext } from './actor-context';
import { SecurityFactsService } from './facts.service';

/**
 * The key this read rides. The same one the API-key surface, the channels surface and the statuses
 * surface use: configuring the account is one scope, and a key per screen stops meaning anything.
 */
export const SECURITY_FACTS_PERMISSION = 'platform.settings.manage';

/**
 * ⭐ W32 / feature 039 (roadmap 12.11) — `AuthService.ListSecurityFacts`.
 *
 * ⚠️ **NOT a maintenance rpc, and the distinction is load-bearing in this repo.** Maintenance rpcs
 * (the sweeps, the ticks) live on their own service, carry a system actor and are reachable from no
 * gateway route. This one answers a HUMAN's permission-gated read, so it is guarded like every other
 * administrative rpc and it IS routed — `tests/worker/maintenance-ticks.spec.ts` would refuse it if
 * it were declared as maintenance and then given a route.
 *
 * ── The second tier, which is the real one (FR-018 / Principle II) ──────────────────────────────
 * The gateway checks `platform.settings.manage` on the route; {@link AuthAccessGuard} checks it again
 * here, against the permission context the gateway forwards. A call that skips the gateway carries no
 * context and is refused. FR-018 says the page is refused server-side «independently of what any
 * interface renders» — a screen that hides itself is not a control at all.
 *
 * ⚠️ The account comes from `readActorContext`, never from the request: `ListSecurityFactsRequest` is
 * an EMPTY message, so there is no field for a crafted call to claim another account with.
 */
@Controller()
@UseGuards(AuthAccessGuard)
export class SecurityFactsGrpcController {
  constructor(@Inject(SecurityFactsService) private readonly facts: SecurityFactsService) {}

  @GrpcMethod('AuthService', 'ListSecurityFacts')
  @RequiresAuthPermission(SECURITY_FACTS_PERMISSION)
  async listSecurityFacts(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    return { facts: await this.facts.list(ctx.accountId) };
  }
}
