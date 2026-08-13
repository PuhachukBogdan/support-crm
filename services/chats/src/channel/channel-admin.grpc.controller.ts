import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { randomBytes, randomUUID } from 'node:crypto';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { AuditRepository } from '../audit/audit.repository';
import { ChannelRepository, type ChannelRow } from './channel.repository';

interface UpsertEmailChannelWire {
  brandId?: string;
  address?: string;
}

/** The wire shape of one configured channel. ⚠️ The KEY is here — the public identifier a delivery
 *  names — and no secret can be: the Channel table holds none (it lives in `CHANNEL_SECRETS`
 *  configuration, looked up BY this key), so "no credential readable after creation" (6.8) is a
 *  property of the schema rather than of this mapping. */
const toWire = (c: ChannelRow) => ({
  id: c.id,
  brandId: c.brand_id,
  kind: c.kind,
  key: c.key,
  address: c.address ?? '',
  enabled: c.enabled,
});

/**
 * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the channels ADMIN surface: list what is configured,
 * add or change a brand's mail address.
 *
 * ── `platform.settings.manage`, and not a new key ────────────────────────────────────────────────
 * A channel row is tenant configuration — and sharper than most: it decides WHICH TENANT AND BRAND an
 * arriving delivery belongs to (`channel.repository.ts`'s own warning). The catalogue already has the
 * key for tenant configuration, held by admin and super-admin only; inventing `crm.channels.manage`
 * would split "who may configure the account" across two keys with no role that holds one and not the
 * other.
 *
 * ── What the write deliberately is NOT ───────────────────────────────────────────────────────────
 * Not an enable/disable toggle, not widget registration, not a desk binding — the rest of 6.8, each
 * listed there. The one write is the operator's named minimum: «добавляю почтовый адрес». Every write
 * is audited (`channel.config_changed`) inside its own transaction.
 *
 * ⚠️ Creating an email channel row does not by itself connect a mailbox: the reader is deployment
 * configuration (worker `CHANNEL_KEY` + IMAP credentials — subpoint 2.1h). The screen says this; the
 * server's job is only to keep the row honest.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ChannelAdminController {
  constructor(
    @Inject(ChannelRepository) private readonly channels: ChannelRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  @GrpcMethod('ChatsReadService', 'ListChannels')
  @RequiresChatsPermission('platform.settings.manage')
  async listChannels(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.channels.listForAccount(ctx.accountId);
    return { channels: rows.map(toWire) };
  }

  @GrpcMethod('ChatsWriteService', 'UpsertEmailChannel')
  @RequiresChatsPermission('platform.settings.manage')
  async upsertEmailChannel(req: UpsertEmailChannelWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const brandId = (req.brandId ?? '').trim();
    const address = (req.address ?? '').trim();
    if (!brandId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'brandId is required' });
    }
    // Our own mailbox address, not a customer's — but still an address something will try to read
    // mail for, so the obviously-not-an-address shapes are refused here rather than stored.
    if (!address || address.length > 320 || /\s/.test(address) || !address.includes('@')) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid address' });
    }

    const existing = await this.channels.emailChannelOf(ctx.accountId, brandId);
    if (existing && (existing.address ?? '') === address) {
      // The audit entry is half the point of this handler, and an entry recording no change is noise
      // in the store that exists to be read — the `setBrand` no-op rule, applied here.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'address unchanged' });
    }

    // The id is decided BEFORE the write so the audit statement can name its target — on a create
    // there is no row to read one from. Detail carries refs and the kind, never the address (the
    // trail references the row, it does not copy it — and the detail layer would refuse an `@`).
    const id = existing?.id ?? randomUUID();
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'channel.config_changed',
      targetRef: id,
      detail: { brandRef: brandId, channelKind: 'email' },
    });

    if (existing) {
      const count = await this.channels.setEmailAddress(ctx.accountId, existing.id, address, statement);
      if (count === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    } else {
      // The key is GENERATED, never chosen: keys are globally unique in practice and that property is
      // what makes the account-free `resolveByKey` safe (see the repository's header).
      const key = `em-${randomBytes(6).toString('hex')}`;
      try {
        await this.channels.createEmailChannel(ctx.accountId, { id, brandId, key, address }, statement);
      } catch (e) {
        // P2002 on @@unique([account_id, brand_id, kind]): a concurrent create won the race. The
        // caller retries and lands in the update branch — better than two rows competing for one
        // brand's mail, which is the exact state the unique exists to forbid.
        if ((e as { code?: string })?.code === 'P2002') {
          throw new RpcException({ code: GrpcStatus.ALREADY_EXISTS, message: 'email channel already exists' });
        }
        throw e;
      }
    }

    const fresh = await this.channels.emailChannelOf(ctx.accountId, brandId);
    if (!fresh) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toWire(fresh);
  }
}
