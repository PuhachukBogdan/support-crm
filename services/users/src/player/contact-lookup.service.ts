import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { CONTACT_HASH_SALT } from '../channel/channel-participant.service';
import { contactHash, type ContactKind } from './contact-match';

/**
 * W9 / spec 035 — the contact lookup (ADR 0044 §4): "does this email/phone belong to a player?"
 *
 * The sharpest security item in the product — the one capability that INVERTS anti-pitching — so
 * the shape is dictated by the ADR and restated here:
 *
 *  · READ-ONLY. `ResolveChannelParticipant` (Maintenance) upserts a participant row as a side
 *    effect; this deliberately shares nothing with it but the hash function and the index.
 *  · BRAND-SCOPED. A match on another brand is another human being (the 07-29 Person repair), so a
 *    cross-brand hit answers `matched: false` rather than leaking presence elsewhere.
 *  · EVERY attempt audited — found, none, ambiguous and rate-capped alike — with the SALTED HASH
 *    of the value and its kind. Volume over time is the only available signal, so the refused
 *    attempt is still a data point. An investigator confirms "was this number looked up" by
 *    hashing it; nobody reads the number out of the log.
 *  · RATE-CAPPED per user by counting the trail itself — the ExportQuota precedent: a DB count on
 *    the `[account_id, actor_user_id, created_at]` index, never the in-memory limiter (per-instance
 *    caps multiply by replica count, and this cap's stated purpose is bounding PII probing volume).
 */

/** Catalogue data, 🅿 until the operator tunes it: 20 lookups per rolling hour, per person. */
export const LOOKUP_CAP_MAX = 20;
export const LOOKUP_CAP_WINDOW_SECONDS = 3600;

export type LookupOutcome = 'found' | 'none' | 'ambiguous' | 'rate_capped';

export interface ContactLookupResult {
  matched: boolean;
  ambiguous: boolean;
  playerId: string;
  brandId: string;
  /** The salted hash the attempt was audited under — for the caller's own trail, never the value. */
  valueHash: string;
}

/** Thrown when the caller is over the cap. The controller maps it to RESOURCE_EXHAUSTED. */
export class LookupRateCapped extends Error {
  constructor() {
    super(`contact lookup rate cap reached (${LOOKUP_CAP_MAX}/${LOOKUP_CAP_WINDOW_SECONDS}s)`);
  }
}

@Injectable()
export class ContactLookupService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    @Inject(CONTACT_HASH_SALT) private readonly salt: string,
  ) {}

  /**
   * The one entry point. `value` arrives raw and is normalised + hashed HERE; it is never stored,
   * never logged, never echoed. An unparseable value (not an email, not a phone) is the caller's
   * typo, refused upstream by the controller before any entry exists — nothing was searched, and
   * an audit row for it would file a probe that never happened.
   */
  async lookup(
    accountId: string,
    actorUserId: string,
    input: { brandId: string; kind: ContactKind; value: string },
    underPreview = false,
  ): Promise<ContactLookupResult> {
    const hash = contactHash(input.kind, input.value, this.salt);
    if (hash === null) {
      // The controller validates shape first; reaching here with an unparseable value is a
      // programming error on our side, not a request — refuse loudly, write nothing.
      throw new Error('unparseable contact value reached the lookup service');
    }

    const record = (outcome: LookupOutcome) =>
      this.audit.append(accountId, {
        action: 'contact.lookup',
        actorUserId,
        // The conversation-context ref is the CHATS side's transition; here the searched brand is
        // the target — the trail answers "who probed which brand's contacts, how often".
        targetRef: input.brandId,
        underPreview,
        detail: { valueHash: hash, valueKind: input.kind, matched: outcome },
      });

    // The scoped client injects the account predicate itself (feature 007) — the same client every
    // tenant read in this service uses, so a cross-account row is structurally unreachable.
    const db = this.prisma.forAccount(accountId);
    const since = new Date(Date.now() - LOOKUP_CAP_WINDOW_SECONDS * 1000);
    const recent = await db.auditEntry.count({
      where: {
        actor_user_id: actorUserId,
        action: 'contact.lookup',
        created_at: { gte: since },
      },
    });
    if (recent >= LOOKUP_CAP_MAX) {
      await record('rate_capped');
      throw new LookupRateCapped();
    }

    // `take: 2` — enough to tell one from many, never a page. The composite outcome names NOBODY
    // when ambiguous: two records sharing a contact within one brand is a data-quality fact the
    // agent cannot resolve from here (0044 §4: no browsable results, confirm-or-nothing).
    const matches = await db.contactMatch.findMany({
      where: { brand_id: input.brandId, value_hash: hash },
      select: { player_id: true, brand_id: true },
      take: 2,
    });

    const outcome: LookupOutcome =
      matches.length === 0 ? 'none' : matches.length === 1 ? 'found' : 'ambiguous';
    await record(outcome);

    return {
      matched: outcome === 'found',
      ambiguous: outcome === 'ambiguous',
      playerId: outcome === 'found' ? matches[0]!.player_id : '',
      brandId: input.brandId,
      valueHash: hash,
    };
  }
}
