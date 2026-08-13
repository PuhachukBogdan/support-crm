import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { CHATS_CLIENT } from '../grpc/clients.module';

interface AcceptDeliveryResponse {
  conversationId?: string;
  messageId?: string;
  duplicate?: boolean;
  refusalClass?: string;
}

interface ChatsChannelGrpc {
  AcceptChannelDelivery(req: {
    channelKey: string;
    rawBodyText: string;
    signature: string;
    receivedAt: number;
  }): Observable<AcceptDeliveryResponse>;
}

/**
 * The channel intake edge (feature 033, roadmap 6.1 — subpoint 2.1a).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * **This route is the only way into the product for a party with no session, and its entire job is
 * three lines of translation.** It preserves the bytes, forwards them with the signature, and maps an
 * outcome to a status code. It does not parse the payload, does not verify the signature, and holds no
 * channel secret — Principle VIII gives the gateway routing and JWT validation and no business logic,
 * and a per-tenant shared secret is tenant configuration rather than transport authentication.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── Why `@Public()` is correct here and not a hole ──────────────────────────────────────────────
 * The global guard checks a session JWT. The caller has none and never will: it is somebody else's
 * server. Its credential is the HMAC over the body, checked in chats against the secret of the channel
 * the key names. So this is not an unauthenticated route — it is a route authenticated by a different
 * mechanism, and the mechanism lives where the secret lives.
 *
 * Every other `@Public()` route in this service is an auth-entry route (login, refresh, registration).
 * This is the first that is not, which is worth saying out loud rather than leaving for someone to notice.
 */
@Controller('channels')
export class ChannelsController implements OnModuleInit {
  private write!: ChatsChannelGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.write = this.client.getService<ChatsChannelGrpc>('ChatsWriteService');
  }

  @Public()
  @Post(':key/inbound')
  // 202 by default: the ticket is durable before we answer, and "accepted" is what a webhook provider
  // stops retrying on. A duplicate answers 200 — see below.
  @HttpCode(202)
  async inbound(
    @Param('key') key: string,
    @Req() req: RawBodyRequest<Request>,
    /**
     * ⚠️ `passthrough: true` — Nest keeps serialising the returned object; this handle exists ONLY to
     * lower the status on a duplicate. Without it `@HttpCode(202)` applies to every success and the
     * 200/202 distinction two comments in this file describe does not exist (found by the W3 live round,
     * 2026-08-05: the round asserted the documented 200 and got 202).
     */
    @Res({ passthrough: true }) res: Response,
  ) {
    /**
     * ⚠️ **`req.rawBody`, never `req.body`.** The signature is over exactly the bytes that arrived, and
     * a parsed-then-reserialised body is a different byte string — different key order, different
     * whitespace — so every signature would fail and the symptom would read as *"the provider signs
     * wrongly"*, which is the hardest kind of fault to attribute because the other party looks
     * responsible. `main.ts` enables `rawBody: true` for this one reason;
     * `channels/raw-body.spec.ts` pins the property.
     */
    const raw = req.rawBody;
    if (!raw || raw.length === 0) throw new BadRequestException({ error: 'empty_body' });

    // ⚠️ NO actor metadata is attached, and there is none to attach: the caller holds no session. Every
    // other call from this service carries `x-actor-*`; this one carries a signature in the body instead,
    // which is why the handler on the other side is the only write handler with no actor to re-check.
    const outcome = await firstValueFrom(
      this.write.AcceptChannelDelivery({
        channelKey: key,
        rawBodyText: raw.toString('utf8'),
        signature: headerOf(req, 'x-crm-signature') ?? '',
        receivedAt: Math.floor(Date.now() / 1000),
      }),
    );

    // ── The refusal map. Each code is a deliberate choice, not an HTTP reflex ────────────────────
    switch (outcome.refusalClass) {
      case '':
      case undefined:
        break;
      case 'unknown_channel':
      case 'disabled':
        // ⚠️ THE SAME ANSWER FOR BOTH. A disabled channel must be indistinguishable from one that never
        // existed: the difference is the confirmation an attacker wants and the one thing a legitimate
        // integration never needs to know.
        throw new NotFoundException({ error: 'unknown_channel' });
      case 'signature':
      case 'replay_window':
        // ⚠️ Also the same answer for both, and for a related reason: telling a caller that its
        // signature was valid but late narrows the search for a forgery to the timestamp alone.
        throw new UnauthorizedException({ error: 'signature_invalid' });
      default:
        // `no_event_id` · `unparseable` · `incomplete` · `loop` · `no_status_configured`. The CLASS
        // travels and nothing else — never a fragment of the payload, which is a stranger's input.
        throw new BadRequestException({ error: outcome.refusalClass });
    }

    // ⚠️ A duplicate is a SUCCESS. A provider re-delivering because its acknowledgement was lost must be
    // told "already accepted" — answering with an error makes it retry for ever (FR-012). The 200/202
    // distinction is there for a human reading a log, not for the caller's control flow.
    if (outcome.duplicate) {
      // 200, not the method's 202: *nothing was created this time*. Both are successes, so no provider's
      // control flow changes — the difference is legible in an access log, which is where somebody asking
      // "is this integration double-delivering?" actually looks.
      res.status(200);
      return { status: 'duplicate', conversationId: outcome.conversationId };
    }
    return { status: 'accepted', conversationId: outcome.conversationId };
  }
}

/** Headers arrive lower-cased; a repeated header is refused rather than joined. */
function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' ? v : undefined;
}
