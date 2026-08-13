import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { StatusRepository, toStatusDefWire } from './status.repository';

/**
 * The account's ticket-status catalogue (feature 032, roadmap 4.16).
 *
 * ── One read, and it is a READ ────────────────────────────────────────────────────────────────────
 * There is no create/update/delete counterpart here on purpose. The authoring screen is roadmap 3.14
 * (block W15a) and it will add its own write handler with its own supervisory permission — an rpc ships
 * with its writer, which is the lesson `every-rpc-is-served` taught this project twice.
 *
 * ── Gated by `crm.inbox.view`, not by a key of its own ────────────────────────────────────────────
 * Reading the vocabulary the inbox is LABELLED with is the same fact class as reading the inbox: a
 * second key would be one nobody remembers to grant, and every holder of the list already sees these
 * words rendered on rows. It reveals no customer data — nine editorial strings the account configured.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class StatusReadController {
  constructor(@Inject(StatusRepository) private readonly statuses: StatusRepository) {}

  @GrpcMethod('ChatsReadService', 'ListConversationStatuses')
  @RequiresChatsPermission('crm.inbox.view')
  async listConversationStatuses(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.statuses.list(ctx.accountId);
    return { statuses: rows.map(toStatusDefWire) };
  }
}
