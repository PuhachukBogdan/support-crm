import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
// ⭐ The SAME projection feature 020 built for cross-brand linking, reused rather than reimplemented:
// that is what makes FR-021a ("no new matching surface over contact values in clear") true by
// construction instead of by discipline.
import { hashContact, normaliseContact } from '../player/contact-match';

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
 * ── ⭐ US3: RESOLUTION, AND THE THREE WAYS IT DECLINES TO GUESS ──────────────────────────────────
 * Who wrote is decided here, from whatever the channel carried, and the rules are all conservative:
 *
 *  1. **Brand-scoped** (FR-020). The same address under another brand is another person until a
 *     `Person` link says otherwise (ADR 0038). A cross-brand match is not used.
 *  2. **More than one candidate ⇒ nobody** (FR-022). The system does not choose. A wrong attachment
 *     puts one customer's words on another customer's record, and the note an agent writes there
 *     survives any later correction (ADR 0044 §5) — so the two outcomes are not symmetric.
 *  3. **No match ⇒ `unidentified`, stated** (FR-024). Not a blank, not a generated stand-in name, not
 *     `***`. The ticket is created with every word the customer wrote either way (FR-023).
 *
 * ⚠️ **The salt does not travel.** `CONTACT_HASH_SALT` is required at this service's boot and is read
 * here; `chats` sends the VALUE over one in-cluster hop and never receives, computes or stores a hash.
 * Copying the salt into chats to avoid that hop would put a secret in a second service purely to protect
 * a value that service already owns (research R10).
 */

/**
 * The hash salt, injected rather than read on the hot path.
 *
 * ⚠️ **Injected so a MISSING salt stops the service instead of silently unidentifying every ticket.** The
 * first draft called `loadUsersConfig()` inside the resolution and caught the failure — which meant a
 * deployment with no salt would answer every request correctly, keep every test green, and quietly mark
 * every arriving conversation as belonging to nobody. That is the shape of defect this project keeps
 * paying for: a fallback where a refusal belonged. As a provider, the factory runs at module construction
 * and the service does not come up without it.
 */
export const CONTACT_HASH_SALT = Symbol('CONTACT_HASH_SALT');

@Injectable()
export class ChannelParticipantService {
  private readonly logger = new Logger(ChannelParticipantService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CONTACT_HASH_SALT) private readonly salt: string,
  ) {}

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
    /**
     * The identifier CLASS the value belongs to — what decides HOW it is resolved (ADR 0044 §4).
     *
     * Defaults to `email` because that is the only class an envelope can be built from today. An
     * absent class is not "guess from the string": a bare value would force this service to decide
     * whether it was looking at an address or a platform id, and a guess about identity is how a phone
     * number gets matched against email hashes.
     */
    identifierKind?: 'email' | 'phone' | 'player_id';
  }): Promise<{ participantId: string; playerId: string; ambiguous: boolean }> {
    // Normalised only by case and whitespace — the same conservative treatment `normaliseContact` gives
    // an email, and for the same reason: correcting presentation is safe, guessing identity is not. The
    // local part of an address is case-sensitive per RFC 5321 and case-insensitive at every provider in
    // practice; folding it means one participant per human instead of one per mail client.
    const address = input.address.trim().toLowerCase();
    const identifierKind = input.identifierKind ?? 'email';

    // ⭐ Who wrote, decided before the row is written so the row is created already correct rather than
    // written blank and patched. The three declining cases are inside {@link resolvePlayer}.
    const resolved = await this.resolvePlayer(input.accountId, input.brandId, identifierKind, address);

    /**
     * ⚠️ **A platform id gets NO envelope row, and that is the contract rather than an omission.**
     *
     * An envelope exists to answer somebody. A widget's player id is not an address — there is nothing to
     * deliver to, and the API channel cannot carry an outbound message at all (`canSend` → `no_transport`).
     * Writing a row anyway would put a non-contact identifier in a column whose whole justification is
     * that this service owns CONTACT values, and it would claim a reply path that does not exist.
     *
     * The caller is told by an empty `participantId`, and it knows which it asked for.
     */
    if (identifierKind === 'player_id') {
      return { participantId: '', playerId: resolved.playerId, ambiguous: resolved.ambiguous };
    }

    const row = (await this.prisma.forAccount(input.accountId).channelParticipant.upsert({
      where: {
        account_id_brand_id_kind_address: {
          account_id: input.accountId,
          brand_id: input.brandId,
          kind: input.kind,
          address,
        },
      },
      /**
       * ⚠️ **Written ONLY when resolution found exactly one player, and never cleared.**
       *
       * Two directions, deliberately asymmetric. Filling it in is new knowledge: an address we could not
       * place last week now matches a player who registered it since. Clearing it would be the opposite —
       * a `ContactMatch` row that has gone (a corrected email, a GR8 sync) would silently unlink threads
       * an agent has been working, and the customer's history would move out from under them.
       *
       * A returning participant is otherwise untouched: `created_at` carries the one fact the row has, and
       * an `update: {}` on a hot path is a statement that there is nothing here to change.
       */
      update: resolved.playerId ? { player_id: resolved.playerId } : {},
      create: {
        account_id: input.accountId,
        brand_id: input.brandId,
        kind: input.kind,
        address,
        player_id: resolved.playerId || null,
      },
      select: { id: true, player_id: true },
    })) as { id: string; player_id: string | null };

    return {
      participantId: row.id,
      // Empty = unidentified, which is a real answer and never blocks intake (FR-023).
      playerId: row.player_id ?? '',
      ambiguous: resolved.ambiguous,
    };
  }

  /**
   * Which player this identifier names — or none, stated (FR-019…FR-022).
   *
   * ── The two classes resolve by two different mechanisms, and neither is a guess ─────────────────
   *  · **`email` / `phone`** — normalised, hashed with this service's salt, matched against
   *    `ContactMatch` on `(brand_id, kind, value_hash)`. That projection exists precisely so matching
   *    needs equality and not the value (feature 020), and reusing it means this feature adds **no new
   *    matching surface over contact values in clear** (FR-021a).
   *  · **`player_id`** — the widget already names the player, so there is nothing to resolve except
   *    whether that player EXISTS in this brand. An id unknown to the brand yields unidentified rather
   *    than a link to a record that is not there (FR-023, US3 scenario 6).
   *
   * ⚠️ **Returns `{ playerId: '', ambiguous: false }` on every failure**, including a value that cannot be
   * normalised. Resolution never throws: FR-023 makes identity unable to block, delay or discard an
   * intake, and an exception here would do all three from the caller's point of view.
   */
  private async resolvePlayer(
    accountId: string,
    brandId: string,
    identifierKind: 'email' | 'phone' | 'player_id',
    value: string,
  ): Promise<{ playerId: string; ambiguous: boolean }> {
    const none = { playerId: '', ambiguous: false };

    if (identifierKind === 'player_id') {
      // Existence only. ⚠️ Scoped to the BRAND as well as the account, because a GR8 player id is unique
      // only within a brand — matching on the id alone is the collision ADR 0038 §3 already had to fix
      // once, and here it would attach a widget conversation to a different human with the same id.
      const player = await this.prisma.forAccount(accountId).player.findFirst({
        where: { brand_id: brandId, player_id: value },
        select: { player_id: true },
      });
      return player ? { playerId: (player as { player_id: string }).player_id, ambiguous: false } : none;
    }

    const normalised = normaliseContact(identifierKind, value);
    // Not usable as evidence about a person — an address that is not shaped like one, a fragment of a
    // phone number. `normaliseContact` is deliberately conservative; an unusable value is unidentified.
    if (normalised === null) return none;

    // ⚠️ No try/catch around the hash. `hashContact` throws only on a salt shorter than 32 characters,
    // which the injected provider has already refused to boot without — and swallowing it here would be
    // the fallback the provider exists to remove: an unsalted hash of an email is a dictionary lookup away
    // from the address, so failing loudly is the only correct direction (`contact-match.ts`).
    const hash = hashContact(identifierKind, normalised, this.salt);

    const rows = (await this.prisma.forAccount(accountId).contactMatch.findMany({
      where: { brand_id: brandId, kind: identifierKind, value_hash: hash },
      select: { player_id: true },
      // ⚠️ Capped at two, which is all the decision needs: one is a match and two is already ambiguous.
      // Without the cap, a support-entered placeholder like `noemail@brand.com` on four thousand records
      // would load four thousand rows on the busiest write path to reach the same verdict.
      take: 2,
    })) as Array<{ player_id: string }>;

    if (rows.length === 0) return none;
    if (rows.length > 1) {
      // ⚠️ **The system does not choose.** Recorded as ambiguity so the reader knows the difference
      // between "nobody has this address" and "we found several and declined" — W9's manual attach is
      // the answer to the second, and it needs to know it is the case.
      return { playerId: '', ambiguous: true };
    }
    return { playerId: rows[0]!.player_id, ambiguous: false };
  }
}
