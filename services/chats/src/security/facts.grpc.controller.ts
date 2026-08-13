import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from './permission.guard';
import { RequiresChatsPermission } from './requires-chats-permission.decorator';
import { readActorContext } from './actor-context';
import { SecurityFactsService } from './facts.service';

/** The same key the channels and statuses admin surfaces ride: configuring the account is one scope. */
export const SECURITY_FACTS_PERMISSION = 'platform.settings.manage';

/**
 * ⭐ W32 / feature 039 (roadmap 12.11) — `ChatsReadService.ListSecurityFacts`.
 *
 * ⚠️ **NOT a maintenance rpc.** It answers a human's permission-gated read, so it is guarded like
 * every administrative rpc and IS reachable from the gateway — which every maintenance rpc in this
 * product deliberately is not.
 *
 * The second tier is the real one (FR-018 / Principle II): the gateway checks the key on the route,
 * {@link ChatsAccessGuard} checks it again here from the forwarded permission context, and a call
 * that skips the gateway carries none and is refused. The account comes from the metadata, never
 * from the request — `ListSecurityFactsRequest` is an EMPTY message, so there is no field for a
 * crafted call to name another account with.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class SecurityFactsGrpcController {
  constructor(@Inject(SecurityFactsService) private readonly facts: SecurityFactsService) {}

  @GrpcMethod('ChatsReadService', 'ListSecurityFacts')
  @RequiresChatsPermission(SECURITY_FACTS_PERMISSION)
  async listSecurityFacts(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    return { facts: await this.facts.list(ctx.accountId) };
  }
}
