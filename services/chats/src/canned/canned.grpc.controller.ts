import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { CannedRepository } from './canned.repository';

interface CreateCannedResponseRequestWire {
  name?: string;
  body?: string;
}

/**
 * Canned responses (feature 013, US2 — roadmap 4.5). Authoring is a template task, so both routes
 * require `crm.templates.manage` at this tier and at the gateway (Principle II).
 *
 * Text only: this controller has no conversation/message dependency at all, so no code path exists
 * by which fetching a canned response could deliver a message (FR-009).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class CannedController {
  constructor(@Inject(CannedRepository) private readonly canned: CannedRepository) {}

  @GrpcMethod('ChatsReadService', 'ListCannedResponses')
  // W8 (2026-08-06): same move as ListMacros — reading is the first half of using; a canned
  // response is text written by leads FOR agents to insert, so the use key is its natural gate.
  // Creating stays `crm.templates.manage`.
  @RequiresChatsPermission('crm.macros.use')
  async listCannedResponses(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    return { canned: await this.canned.list(ctx.accountId) };
  }

  @GrpcMethod('ChatsWriteService', 'CreateCannedResponse')
  @RequiresChatsPermission('crm.templates.manage')
  async createCannedResponse(req: CreateCannedResponseRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const name = (req.name ?? '').trim();
    const body = (req.body ?? '').trim();
    if (!name || !body) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'name and body are required',
      });
    }
    try {
      return await this.canned.create(ctx.accountId, name, body);
    } catch {
      // Unique per (account, name) — a duplicate conflicts instead of creating a second entry.
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'canned response name already used',
      });
    }
  }
}
