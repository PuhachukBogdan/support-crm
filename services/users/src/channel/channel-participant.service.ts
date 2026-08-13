import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Who wrote on a channel, and where to answer them (feature 033, roadmap 6.4 — research R9/R10).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THIS SERVICE OWNS THE CUSTOMER'S ADDRESS BECAUSE IT ALREADY OWNS CONTACT VALUES.**
 *
 * Replying to an email needs the address the customer wrote **from**. A salted hash cannot give it
 * back, and the player's registered address must not stand in for it: a player may write from a second
 * address, and answering the registered one would deliver a stranger's conversation to them.
 *
 * So the value is stored — in clear, deliberately — and it is stored **here**, where the masking regime,
 * the field-tier policy and the hash salt already are. `chats` receives an opaque handle and has no
 * column an address could go into. The rejected alternative was storing it beside the conversation,
 * which would have made a service with no masking regime the owner of a contact value (FR-021b).
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── What this file does NOT do yet ──────────────────────────────────────────────────────────────
 * **Resolve the player.** `player_id` is left NULL and the answer says unidentified. The salted-hash
 * match against `ContactMatch` arrives with US3, and separating the two is what makes the email path
 * shippable before identity: a ticket that exists, is complete, and is honestly marked as belonging to
 * nobody yet is exactly what ADR 0044 §1 asks for.
 */
@Injectable()
export class ChannelParticipantService {
  private readonly logger = new Logger(ChannelParticipantService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Register this address for this brand's channel and return its handle.
   *
   * ⚠️ **Idempotent by the unique key, not by a prior read.** A returning customer must reuse their row
   * rather than accumulate one per conversation, and two messages arriving at once must not both insert.
   * `upsert` on `@@unique([account_id, brand_id, kind, address])` is one statement the database
   * serialises; a `findFirst` followed by a `create` is the race this project has paid for twice.
   *
   * ⚠️ **The address is never logged**, here or anywhere on this path (FR-047). The only line this
   * method can emit names the brand and the kind — see below.
   */
  async register(input: {
    accountId: string;
    brandId: string;
    kind: string;
    address: string;
  }): Promise<{ participantId: string; playerId: string; ambiguous: boolean }> {
    // Normalised only by case and whitespace — the same conservative treatment `normaliseContact` gives
    // an email, and for the same reason: correcting presentation is safe, guessing identity is not. The
    // local part of an address is case-sensitive per RFC 5321 and case-insensitive at every provider in
    // practice; folding it means one participant per human instead of one per mail client.
    const address = input.address.trim().toLowerCase();

    const row = (await this.prisma.forAccount(input.accountId).channelParticipant.upsert({
      where: {
        account_id_brand_id_kind_address: {
          account_id: input.accountId,
          brand_id: input.brandId,
          kind: input.kind,
          address,
        },
      },
      // Nothing to change on a returning participant. The row is a stable handle, and touching
      // `created_at` would lose the one fact it carries — when we first heard from this address.
      update: {},
      create: {
        account_id: input.accountId,
        brand_id: input.brandId,
        kind: input.kind,
        address,
      },
      select: { id: true, player_id: true },
    })) as { id: string; player_id: string | null };

    return {
      participantId: row.id,
      // US3 fills this. Empty = unidentified, which is a real answer and never blocks intake (FR-023).
      playerId: row.player_id ?? '',
      ambiguous: false,
    };
  }
}
