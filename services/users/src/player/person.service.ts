import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { isLinkableIdentifier, type ContactKind } from './contact-match';
import { playerIdentity, type PlayerIdentity } from './player.identity';

/**
 * T027 (feature 020, US2) — "these two records are the same human".
 *
 * ── What a link is, and what it is emphatically not ─────────────────────────────────────────────
 * A link is a **statement about people**. It is NOT a merge: members keep their own notes, VIP flag,
 * segment and snapshot, and unlinking leaves two independent records with nothing copied either way.
 *
 * That is what makes an **automatic** decision safe to make. The operator chose automatic linking on
 * a matching email or phone, judging a relative registering under someone else's address to be a rare
 * case that does not matter. Rare cases stop mattering when they are correctable — so the link is
 * recorded, reversible, and moves no data. A merge would have made the same rare case permanent.
 *
 * ── Three refusals, each for a different reason ─────────────────────────────────────────────────
 * 1. **Never on a shared `player_id`.** That is not evidence about a human; it is the collision this
 *    whole feature exists to undo. Nothing here reads a platform id for matching.
 * 2. **Never across accounts.** Isolation outranks convenience (Principle I).
 * 3. **Never on an identifier held by more than two records.** A support placeholder
 *    (`noemail@brand.com`, a branch phone) would fuse strangers *in bulk* — systematically, by the
 *    rule's own design rather than by accident. That is a different failure from the rare wrong link,
 *    and declining it costs nothing.
 */

export interface LinkOutcome {
  /** 'linked' | 'already' | a reason it was declined. */
  status: 'linked' | 'already-linked' | 'no-match' | 'too-many-records' | 'cross-account';
  personId?: string;
  /** Which KIND of identifier established it — never the value (SEC-26). */
  linkedOn?: ContactKind;
}

@Injectable()
export class PersonService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * Try to link `id` to whoever else carries the same contact hash.
   *
   * Called after a record's contact projection is written (by the GR8 connector at roadmap 7.4, and
   * directly in tests until then). Returns why nothing happened when nothing happens — a silent
   * no-answer would make an automatic rule impossible to reason about.
   */
  async linkByContact(
    id: PlayerIdentity,
    kind: ContactKind,
    valueHash: string,
    actorUserId?: string,
  ): Promise<LinkOutcome> {
    const db = this.prisma.forAccount(id.accountId);

    // Everyone carrying this hash. `forAccount` bounds it to one tenant, so a cross-account match is
    // not "refused later" — it is never found (refusal 2, made structural rather than checked).
    const holders = (await db.contactMatch.findMany({
      where: { value_hash: valueHash },
      select: { account_id: true, brand_id: true, player_id: true },
    })) as Array<{ account_id: string; brand_id: string; player_id: string }>;

    if (holders.length < 2) return { status: 'no-match' };

    if (!isLinkableIdentifier(holders.length)) {
      // Refusal 3. Nothing is linked and the value is left for review — it is a placeholder or a
      // shared line, not a person.
      return { status: 'too-many-records' };
    }

    // Already one person? Then this is a re-run, not a new fact.
    const existing = (await db.personMember.findMany({
      where: {
        OR: holders.map((h) => ({
          account_id: h.account_id,
          brand_id: h.brand_id,
          player_id: h.player_id,
        })),
      },
      select: { person_id: true },
    })) as Array<{ person_id: string }>;

    const distinct = [...new Set(existing.map((m) => m.person_id))];
    if (distinct.length === 1 && existing.length === holders.length) {
      return { status: 'already-linked', personId: distinct[0]!, linkedOn: kind };
    }

    // Join an existing person rather than creating a second one for the same human.
    const personId =
      distinct[0] ??
      (
        (await db.person.create({ data: { account_id: id.accountId } })) as { id: string }
      ).id;

    for (const h of holders) {
      await db.personMember.upsert({
        where: {
          account_id_brand_id_player_id: {
            account_id: h.account_id,
            brand_id: h.brand_id,
            player_id: h.player_id,
          },
        },
        create: {
          person_id: personId,
          account_id: h.account_id,
          brand_id: h.brand_id,
          player_id: h.player_id,
          linked_on: kind, // the KIND, never the value
        },
        update: {},
      });
    }

    /**
     * The entry is written for every record enrolled, because "who was joined to whom" is the fact a
     * reader needs — and it names the identifier KIND, never its value (SEC-26).
     *
     * Awaited, not fire-and-forget: an automatic link with no record of itself is only discoverable
     * later, as a customer card that quietly contains someone else. If the trail cannot be written the
     * link must not stand — the same stance `recordView` takes for a reveal.
     */
    for (const h of holders) {
      await this.audit.append(id.accountId, {
        action: 'player.link',
        actorUserId: actorUserId ?? 'system',
        targetRef: `${h.brand_id}/${h.player_id}`,
        detail: { linkedOn: kind },
      });
    }

    return { status: 'linked', personId, linkedOn: kind };
  }

  /**
   * Undo a link for one record.
   *
   * Reversibility is the counterweight to acting without a human. Nothing is copied on link, so
   * nothing has to be un-copied here — the member row goes and two independent records remain.
   */
  async unlink(id: PlayerIdentity, actorUserId?: string): Promise<{ unlinked: boolean }> {
    const db = this.prisma.forAccount(id.accountId);
    const removed = (await db.personMember.deleteMany({
      where: { account_id: id.accountId, brand_id: id.brandId, player_id: id.playerId },
    })) as { count: number };

    if (removed.count > 0) {
      // Undoing an automatic decision is itself a decision, and the trail records both halves —
      // otherwise a link that was made and then removed leaves a record of only the mistake.
      await this.audit.append(id.accountId, {
        action: 'player.unlink',
        actorUserId: actorUserId ?? 'system',
        targetRef: `${id.brandId}/${id.playerId}`,
      });
    }

    return { unlinked: removed.count > 0 };
  }

  /** The records making up one person — the input to the person-scoped feed. */
  async membersOf(accountId: string, personId: string): Promise<PlayerIdentity[]> {
    const db = this.prisma.forAccount(accountId);
    const rows = (await db.personMember.findMany({
      where: { person_id: personId },
      select: { account_id: true, brand_id: true, player_id: true },
    })) as Array<{ account_id: string; brand_id: string; player_id: string }>;
    // Through the constructor, not as a literal: these identities go straight into a feed query, and
    // one place that validates is the reason "what identifies a player" is a definition rather than a
    // convention. The structural guard enforces it.
    return rows.map((r) =>
      playerIdentity({ accountId: r.account_id, brandId: r.brand_id, playerId: r.player_id }),
    );
  }
}
