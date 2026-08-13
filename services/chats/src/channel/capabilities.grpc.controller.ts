import { Controller, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { channelKindToWire, listChannelCapabilities } from '@crm/common';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';

/**
 * What each channel kind can do (feature 033, roadmap 6.6 — T074, subpoint 2.1e).
 *
 * ── ⭐ THE READ EVERY LATER BLOCK STANDS ON ──────────────────────────────────────────────────────
 * W6's Inbox filters and tabs, W7's reply box, W20's analytics split, and every channel added after
 * this one. The whole point of shipping it now is that a new channel arrives as a **row in the matrix**
 * rather than as a branch in four screens — which is the arrangement roadmap 6.6 asks for in as many
 * words: *"заложить в матрицу как данные, а не как код"*.
 *
 * ── Why it is account-independent, and why it is still gated ─────────────────────────────────────
 * These are **product facts**, not account configuration: a Telegram bot cannot write first no matter
 * whose account it is. So there is no account in the answer and no per-account row to read — unlike the
 * status catalogue beside it, which is configuration precisely so a supervisor can change it.
 *
 * It is nevertheless gated on `crm.inbox.view`, for the reason the status catalogue records: reading the
 * vocabulary the inbox is described with is the same fact class as reading the inbox, and a key of its
 * own would be one nobody remembers to grant. Nothing here reveals customer data.
 *
 * ⚠️ **No write counterpart, and there must not be one.** The matrix is a closed catalogue in
 * `libs/common/src/channels/`, which is what makes it the single source of truth; an authoring surface
 * would make a platform's own rules editable per deployment, and a wrong edit would be invisible until
 * WhatsApp refused a message nobody could explain.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ChannelCapabilitiesController {
  @GrpcMethod('ChatsReadService', 'GetChannelCapabilities')
  @RequiresChatsPermission('crm.inbox.view')
  getChannelCapabilities() {
    return {
      capabilities: listChannelCapabilities().map((c) => ({
        // The wire enum value, explicit rather than string-munged — `wire.ts`'s precedent.
        kind: channelKindToWire(c.kind),
        mayInitiate: c.mayInitiate,
        replyWindowHours: c.replyWindowHours,
        supportsAttachments: c.supportsAttachments,
        templateRequiredToInitiate: c.templateRequiredToInitiate,
        liveTransport: c.liveTransport,
        // ⭐ Both directions travel. A consumer deciding whether to offer a reply box needs the OUT one;
        // `liveTransport` alone is what let the send gate allow an API-channel reply (US4).
        outboundTransport: c.outboundTransport,
      })),
    };
  }
}
