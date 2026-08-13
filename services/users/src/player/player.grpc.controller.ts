import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '@crm/common';
import { OperatorRepository, type OperatorRow } from '../operator/operator.repository';
import { ContactViewAuditService } from './contact-view-audit.service';
import { ContactLookupService, LookupRateCapped } from './contact-lookup.service';
import { normaliseContact } from './contact-match';
import { PlayerAccessGuard } from './player.guard';
import { RequiresPlayerPermission } from './requires-player-permission.decorator';
import { assertCanMassExport, maskPlayer } from './player.masking';
import { PlayerRepository, type PlayerRow } from './player.repository';
import { readPlayerActor, resolveListBrand, type PlayerActor } from './actor';
import { playerIdentity } from './player.identity';
import { PersonService } from './person.service';
import { AssignmentRepository } from '../assignment/assignment.repository';
import type { PresenceState } from '@crm/common';

/**
 * Domain state → wire enum for `ResolvedOperator.state` (feature 025).
 *
 * Local to this file rather than shared: the wire numbering belongs to the contract, and the two
 * other surfaces that encode it own their own. A shared encoder would be a third place to change
 * when the proto changes, and the proto is the source of truth for all three.
 */
const PRESENCE_STATE_WIRE: Readonly<Record<PresenceState, number>> = {
  online: 1,
  transfers_only: 2,
  away: 3,
  offline: 4,
};

interface GetPlayerWire {
  /** Required since feature 020 — a platform id alone names two customers, not one. */
  brandId?: string;
  playerId?: string;
}
interface GetOperatorWire {
  operatorId?: string;
}
interface ListByBrandWire {
  brandId?: string;
  pageToken?: string;
  pageSize?: number;
}

/**
 * The player + operator read surface (feature 018, roadmap 5.1).
 *
 * These three RPCs have been **declared in the owned contract since Phase 2 and served by nothing**. Four
 * units were built ahead of this surface — the read path (2.7), the anti-pitching masking, the contact-view
 * audit and the service-tier guard (all 011) — each with a comment naming this point. This controller is
 * where they get wired, and it introduces no second copy of any of them.
 *
 * ⚠️ `UsersReadService` is now implemented across **TWO** controllers (this one and the audit reader). Nest
 * merges them into one gRPC service; `hosting.spec.ts` asserts all four methods actually answer, because a
 * handler map that silently drops one is precisely feature 015's live-only defect.
 */
@Controller()
@UseGuards(PlayerAccessGuard)
export class PlayerReadController {
  constructor(
    @Inject(PlayerRepository) private readonly players: PlayerRepository,
    @Inject(OperatorRepository) private readonly operators: OperatorRepository,
    @Inject(ContactViewAuditService) private readonly access: ContactViewAuditService,
    @Inject(PersonService) private readonly persons: PersonService,
    /**
     * ⭐ Feature 026 (roadmap 5.7). The narrowing asks the attachment a question on every masked
     * read, so this controller depends on it — and the dependency is deliberate rather than
     * regrettable: adding a required constructor argument is what made the compiler enumerate every
     * test that constructs this controller, forcing each to state whether the caller is attached.
     * A test that does not say is a test that was not thinking about the tier (FR-014).
     */
    @Inject(AssignmentRepository) private readonly assignments: AssignmentRepository,
    // W9: the lookup's security story (audit + cap + hash) lives in its own service.
    @Inject(ContactLookupService) private readonly contactLookup: ContactLookupService,
  ) {}

  /**
   * One customer record, shaped by the caller's role.
   *
   * Order matters and is the design: read → **not found stops here** → mask → audit → wire. A record that
   * does not exist (or is not this account's) is refused **before** any entry is written, because nothing
   * was revealed; auditing a 404 would file a reveal that never happened, which is the property feature
   * 015's live run recorded for deletions.
   */
  @GrpcMethod('UsersReadService', 'GetPlayer')
  @RequiresPlayerPermission('crm.contact.view')
  async getPlayer(req: GetPlayerWire, metadata: Metadata) {
    const actor = readPlayerActor(metadata);

    /**
     * ⚠️ The brand is REQUIRED and its absence is refused, not defaulted (feature 020, FR-003).
     *
     * GR8's `player_id` is unique only within a brand, so a request naming only a platform id does
     * not identify a customer — it names two. Answering it with "the first match" is how one person's
     * card came to show another's data. `playerIdentity` cannot be built from a partial triple, so the
     * refusal happens here rather than deep in a query.
     */
    let identity;
    try {
      identity = playerIdentity({
        accountId: actor.accountId,
        brandId: String(req?.brandId ?? ''),
        playerId: String(req?.playerId ?? ''),
      });
    } catch {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'brandId and playerId are both required',
      });
    }

    const row = (await this.players.getPlayer(identity)) as PlayerRow | null;

    // Unknown id and another account's id land here identically — one answer, one message, no oracle.
    if (!row) throw notFound();

    /**
     * Feature 022 (roadmap 4.13): which HUMAN this record belongs to, so a card opened on a player can
     * address the person-level reads at all. One indexed lookup on the key feature 020 already created;
     * absent link ⇒ absent identifier, never a synthesised person of one.
     *
     * Resolved BEFORE masking and folded into the object the mask reads, so the field goes THROUGH the tier
     * policy rather than around it. It is classified `open` — identity, not contact data — but the route it
     * takes is what matters: a field added past the mask is a field no policy governs.
     */
    const personId = await this.players.personIdOf(identity);

    /**
     * ⭐ Feature 026 (roadmap 5.7): is the caller attached to THIS player?
     *
     * Resolved before masking, because it is now an input to the tier decision. One indexed lookup
     * on the index that exists for it. ⚠️ Note whose attachment is asked about — the CALLER's, not
     * the player's: "who looks after this customer" is a different question from "may I see their
     * portfolio", and only the second one masks.
     */
    const attachedToSubject = await this.assignments.isAttached(
      actor.accountId,
      { brandId: identity.brandId, playerId: identity.playerId },
      actor.userId,
    );

    const subject = { ...(row as unknown as Record<string, unknown>), person_id: personId };
    const masked = maskPlayer(subject, actor.effectiveRole, { attachedToSubject });

    /**
     * STRICT, and awaited before anything is returned (FR-016).
     *
     * An unaudited reveal is the harvesting vector the finding exists to detect, not a lost statistic — so
     * a failure here propagates and the caller gets no data. The tier recorded follows the caller's
     * CLEARANCE, not which fields held a value.
     *
     * ⚠️ For an open-only role this currently writes NOTHING, which is a documented blind spot rather than
     * an oversight: closing it needs `record.open`, and feature 015 attached a retention precondition to
     * that action which is still unmet (SEC-25). See the writer for the full note.
     */
    await this.access.recordView(
      actor.accountId,
      actor.userId,
      // The full subject — the trail has to say WHICH customer, and a platform id alone no longer does.
      { brandId: row.brand_id, playerId: row.player_id },
      actor.effectiveRole,
      actor.underPreview,
      // ⭐ Feature 026: the SAME attachment the masking used, so the entry records what was actually
      // surfaced. Passing the role alone here would file an entry claiming an unattached AM read the
      // portfolio — overstating the one trail whose job is detecting over-reach.
      attachedToSubject,
    );

    return toPlayerWire(masked, row, actor);
  }

  /**
   * One page of a brand's customers.
   *
   * ── The ORDER of the refusals is the requirement, not an implementation detail ─────────────────
   * context → permission → **bulk-read guard** → brand intersection → query → mask → ONE entry. The guard
   * runs **before the repository**, so a refused bulk request has read nothing and written nothing. Guarding
   * after the read would still refuse — and would already have pulled a page of customer records into
   * memory and filed an access entry for a disclosure that did not happen.
   */
  @GrpcMethod('UsersReadService', 'ListPlayersByBrand')
  @RequiresPlayerPermission('crm.contact.view')
  async listPlayersByBrand(req: ListByBrandWire, metadata: Metadata) {
    const actor = readPlayerActor(metadata);

    /**
     * SEC-AP2, live at last.
     *
     * Built and unit-tested at feature 011 and never wired, because no bulk surface existed. Feature 017
     * could not give it one either — no export scope carries contact data. This list is a bulk path over
     * contact-bearing records, so this call is where the guard finally guards something.
     *
     * The name says "export" and this is a read: the policy it consults is about bulk contact DISCLOSURE,
     * and ten thousand customers in a paged response is that regardless of file format.
     */
    assertCanMassExport(actor.effectiveRole);

    const brandId = resolveListBrand(String(req?.brandId ?? ''));
    // A list without a brand is an EMPTY PAGE, never a wider result. A player is identified by
    // (account_id, brand_id, player_id) — feature 020 — so a missing brand makes the query unanswerable,
    // and the dangerous direction is the widening one: a request for one brand quietly becoming a request
    // for all of them.
    if (!brandId) return { players: [], nextPageToken: '' };

    let cursor;
    try {
      cursor = decodeCursor(req?.pageToken);
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw err;
    }

    const page = await this.players.listByBrand(
      actor.accountId,
      brandId,
      clampPageSize(req?.pageSize),
      cursor,
    );

    // ONE entry for the request, targeting the BRAND — not one per record. Same call feature 017 made for
    // exports: a per-row trail over a paged list is useless to read and is the largest surface for leaking
    // a value. Strict, like every reveal.
    await this.access.recordBulkRead(
      actor.accountId,
      actor.userId,
      brandId,
      actor.effectiveRole,
      ['brandId'],
      actor.underPreview,
    );

    // Feature 022: ONE membership lookup for the WHOLE page. A lookup per row would be a textbook N+1
    // (Principle VII) — and the kind that only shows up as a slow screen once a brand has thousands of
    // customers. `player.list.spec.ts` counts the queries rather than trusting this comment.
    // ⭐ Feature 026: the attachments for the WHOLE page, in ONE query — beside the membership
    // lookup, for the same reason. A call per row would be a textbook N+1 on a screen that grows
    // with the customer base (Principle VII), and `player.list.spec.ts` counts the queries.
    const attached = await this.assignments.attachedAmong(
      actor.accountId,
      page.rows.map((r) => ({ brandId: r.brand_id, playerId: r.player_id })),
      actor.userId,
    );

    const personIds = await this.players.personIdsFor(
      actor.accountId,
      brandId,
      page.rows.map((r) => r.player_id),
    );

    return {
      players: page.rows.map((row) => {
        // Built as a named subject first, so the masking call stays the one-line shape
        // `tests/users-read/single-policy-path.spec.ts` reads: that guard asserts BOTH handlers mask through
        // the same function with the ACTOR's role, and it parses the call's arguments as text. Inlining a
        // multi-line spread here truncated what it could see — the guard was right about the shape.
        const subject = {
          ...(row as unknown as Record<string, unknown>),
          person_id: personIds.get(row.player_id) ?? null,
        };
        // Computed on its own line for the same reason `subject` is: `single-policy-path.spec.ts`
        // parses the masking call's arguments AS TEXT and refuses any quote or backtick in them, so
        // that a literal role can never be smuggled in. A template literal inline would trip a guard
        // that is right to be strict — the key belongs here, not in the call.
        const attachedToSubject = attached.has(`${row.brand_id}|${row.player_id}`);
        return toPlayerWire(maskPlayer(subject, actor.effectiveRole, { attachedToSubject }), row, actor);
      }),
      nextPageToken: page.nextCursor ? encodeCursor(page.nextCursor) : '',
    };
  }

  /**
   * One staff record.
   *
   * **No tier masking and no access entry, and that is a decision rather than an omission** (research R8).
   * The visibility policy classifies CUSTOMER fields; an operator is staff, and their display name already
   * renders on every message they sent — so auditing a read of it would record something the reader can see
   * by scrolling. Gated by the inbox permission, because resolving who a conversation is assigned to is part
   * of using the inbox.
   *
   * If an operator record ever grows a personal field, this comment is the one that has to change.
   */
  /**
   * Which brand-scoped records make up one human (feature 020).
   *
   * **No masking and no access entry, and that is deliberate** — the answer contains no customer
   * field at all: it is a list of identities, which the caller already had to hold one of to ask.
   * Gated by the contact permission because knowing that two records are one person is itself a
   * statement about a customer, even without a value attached.
   *
   * `forAccount` bounds it, so a person from another tenant is not "refused" — it is not found.
   */
  @GrpcMethod('UsersReadService', 'ListPersonMembers')
  @RequiresPlayerPermission('crm.contact.view')
  async listPersonMembers(req: { personId?: string }, metadata: Metadata) {
    const actor = readPlayerActor(metadata);
    const personId = String(req?.personId ?? '');
    if (!personId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'personId is required',
      });
    }
    const members = await this.persons.membersOf(actor.accountId, personId);
    return { members: members.map((m) => ({ brandId: m.brandId, playerId: m.playerId })) };
  }

  @GrpcMethod('UsersReadService', 'GetOperator')
  @RequiresPlayerPermission('crm.inbox.view')
  async getOperator(req: GetOperatorWire, metadata: Metadata) {
    const actor = readPlayerActor(metadata);
    const row = await this.operators.getById(actor.accountId, String(req?.operatorId ?? ''));
    if (!row) throw notFound();
    return toOperatorWire(row, actor);
  }

  /**
   * AUTH user ids → assignable operator profiles (feature 024, roadmap 5.3).
   *
   * Gated by `crm.conversation.assign`, not by the inbox key: the only reason to ask this question is
   * to route work, and the answer — who is available to take a conversation — is an operational fact
   * about staffing rather than something every inbox reader needs. It carries **no customer data at
   * all**, so there is nothing to mask and nothing to audit as an access.
   *
   * The caller forwards its own credentials unchanged; calling as a system actor would launder the
   * permission, which is the rule feature 022 established for `ListPersonMembers` one field over.
   */
  @GrpcMethod('UsersReadService', 'ListOperatorsByAuthUsers')
  @RequiresPlayerPermission('crm.conversation.assign')
  async listOperatorsByAuthUsers(req: { authUserIds?: string[] }, metadata: Metadata) {
    const actor = readPlayerActor(metadata);
    const asked = Array.isArray(req?.authUserIds) ? req.authUserIds.map((id) => String(id ?? '')) : [];
    const resolved = await this.operators.resolveByAuthUserIds(actor.accountId, asked);

    // ── Feature 025 (roadmap 5.9): availability rides this answer ────────────────────────────────
    //
    // The repository does the enrichment, not this handler, and that placement is deliberate: ONE
    // method answers "who can take this work?" completely — the `Operator.active` filter (roadmap
    // 3.16, the staff account is not deactivated) and the presence state (is this person at their
    // desk right now) belong beside each other. They are separate FACTS and must never be merged,
    // but they are answers to the same question, and splitting the query across two layers is how a
    // caller ends up applying one and forgetting the other.
    return {
      operators: resolved.map((r) => ({
        operatorId: r.operatorId,
        authUserId: r.authUserId,
        state: PRESENCE_STATE_WIRE[r.state] ?? 4,
        // ONLY the switched-off channels. Absence means available, so an empty list is the normal
        // and most common answer (FR-019).
        blockedChannels: r.blockedChannels,
      })),
    };
  }

  /**
   * W9 / spec 035 — the contact lookup (ADR 0044 §4). The whole security story lives in
   * {@link ContactLookupService}; this handler owns the WIRE rules:
   *
   *  · validation errors name the KEY, never the value (SEC-26 — the searched value is a contact);
   *  · an unparseable value is refused with NO audit entry — nothing was searched, and a row for a
   *    typo would file a probe that never happened (the same rule GetPlayer applies to 404s);
   *  · the rate cap surfaces as RESOURCE_EXHAUSTED, and that attempt IS audited (volume is the
   *    only available anomaly signal, so the refusal is a data point).
   */
  @GrpcMethod('UsersReadService', 'LookupPlayerByContact')
  @RequiresPlayerPermission('crm.contact.lookup')
  async lookupPlayerByContact(
    req: { brandId?: string; kind?: string; value?: string },
    metadata: Metadata,
  ) {
    const actor = readPlayerActor(metadata);
    const brandId = (req?.brandId ?? '').trim();
    const kind = req?.kind === 'email' || req?.kind === 'phone' ? req.kind : null;
    const value = (req?.value ?? '').trim();
    if (!brandId || !kind || !value) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'brandId, kind (email|phone) and value are required',
      });
    }
    if (normaliseContact(kind, value) === null) {
      // The key of the failure, never the value: "value" here is a customer contact by definition.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: `value is not a well-formed ${kind}`,
      });
    }

    try {
      const res = await this.contactLookup.lookup(
        actor.accountId,
        actor.userId,
        { brandId, kind, value },
        actor.underPreview,
      );
      return {
        matched: res.matched,
        ambiguous: res.ambiguous,
        playerId: res.playerId,
        brandId: res.brandId,
      };
    } catch (err) {
      if (err instanceof LookupRateCapped) {
        throw new RpcException({ code: GrpcStatus.RESOURCE_EXHAUSTED, message: err.message });
      }
      throw err;
    }
  }
}

const notFound = () => new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

/**
 * Build the wire message from the MASKED row.
 *
 * ⚠️ **Three rules here, all established by executing the masking policy rather than reading it — and the
 * third is the one that matters after this feature ships.**
 *
 * 1. **An EXPLICIT field list, never a spread.** `maskPlayer` KEEPS `gr8_snapshot` for admin/super_admin,
 *    because they are cleared for its tier. What keeps that customer PII out of every response is that the
 *    contract has no field for it — so a `...masked` here would serve it to every broad role, silently,
 *    with every existing test still green. This function is the guarantee.
 * 2. **`account_id` comes from the ACTOR, not the masked row.** It is unclassified, so masking drops it for
 *    every role including the broadest, and reading it from `masked` would make the field empty for
 *    everybody. It is context — the caller's own tenant — not customer data. Adding it to the tier policy
 *    would be the wrong repair: a tenancy value would acquire a clearance level it has no business having.
 * 3. **`brand_ids` is DERIVED from the surviving `brands` relation**, which is what the policy actually
 *    classifies. A reader comparing contract to policy finds `brand_ids` unclassified and would reasonably
 *    assume it is dropped.
 *
 * 4. **A withheld field is OMITTED here, never written as a placeholder** (added 2026-07-29, feature 019).
 *    This function used to write `?? ''` for each maskable field. proto3 has no presence for singular
 *    scalars, so the blank travelled and every REST response carried every key — violating 011's FR-014
 *    ("fields a role may not see are ABSENT from the serialized response"), which two documents claimed
 *    was already true. The value never leaked; the letter of the requirement did not hold. The edge now
 *    drops default-valued fields (`services/gateway/src/players/wire.ts`), and this function stops
 *    manufacturing the defaults that made the drop necessary in the first place.
 *
 *    ⚠️ **Never reintroduce a fallback on a maskable field.** `?? ''` is invisible again; `?? 'n/a'`
 *    would be worse — a non-default value sails straight through the edge's projection.
 *
 * A consumer still cannot tell "you may not see this" from "this is empty": both arrive absent. That is
 * deliberate and is the reason the edge omits by VALUE rather than by clearance — telling a caller WHICH
 * fields were withheld is itself a disclosure about the record.
 */
function toPlayerWire(
  masked: Partial<Record<string, unknown>>,
  row: PlayerRow,
  actor: PlayerActor,
) {
  const out: Record<string, unknown> = {
    playerId: (masked.player_id as string) ?? row.player_id,
    accountId: actor.accountId, // rule 2
    /**
     * Rule 3, rewritten by feature 020. `brand_id` is now a COLUMN on the row and part of its
     * identity, so it is read straight from the row rather than derived from a brand-union edge that
     * no longer exists. `brandIds` keeps its field number and its repeated type — the contract
     * deprecates it in place rather than narrowing it, because consumers already read it — and it
     * carries the one brand this record belongs to.
     */
    brandId: row.brand_id,
    brandIds: [row.brand_id],
    // No gr8 field exists on this message, by design — see rule 1.
  };

  // Rule 4: present only when the mask kept them. Still an explicit list — the loop walks a fixed
  // pairing of wire name to masked column, so a new column cannot arrive here by accident.
  const maskable: [string, unknown][] = [
    /**
     * Feature 022 — tier `open`, so every role that can open a card at all sees it. It goes through the
     * SAME masked-value gate as everything else rather than around it: `masked.person_id` is present only
     * when the caller's tier permits the field, and the value is then supplied from the resolved lookup.
     *
     * A linear agent could always see which brand a customer came from; "these two records are one person"
     * is the same class of fact with no value attached. What must NOT change is the masking boundary — a
     * caller below it still gets no contact fields, which `player.masking.spec.ts` asserts.
     */
    ['personId', masked.person_id],
    ['vip', masked.vip],
    ['segment', masked.segment],
    ['amNotes', masked.am_notes],
    ['customAttributesJson', jsonOrAbsent(masked.custom_attributes)],
    ['preferencesJson', jsonOrAbsent(masked.preferences)],
    ['portfolioJson', jsonOrAbsent(masked.portfolio)],
  ];
  for (const [key, value] of maskable) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Like `toJson`, but keeps ABSENCE absent instead of turning it into an empty string (rule 4). */
function jsonOrAbsent(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

/**
 * The account on the wire is the CALLER'S context, here as on the player path.
 *
 * The row's own `account_id` would give the same value — it was fetched under that scope — but taking it
 * from one place on both paths means there is no reader left wondering why two responses in the same file
 * source the same field differently. It also leaves no `row.account_id` read for an isolation scan to have
 * to reason about.
 */
function toOperatorWire(row: OperatorRow, actor: PlayerActor) {
  return {
    operatorId: row.id,
    accountId: actor.accountId,
    displayName: row.display_name ?? '',
    // Returned, not filtered on: a name still has to render on last year's conversations.
    active: row.active,
  };
}

// `toJson` lived here until 2026-07-29 and mapped an absent column to `''`. It was the last of the
// blanking helpers and is replaced by `jsonOrAbsent`, which keeps absence absent (rule 4). Deleted
// rather than left unused: a helper that turns "withheld" into "empty" is exactly the shape of the
// defect feature 019 found, and leaving one in the file invites its reuse.
