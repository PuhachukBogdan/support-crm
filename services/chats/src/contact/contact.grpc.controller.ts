import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { ContactSummaryRepository } from './contact-summary.repository';
import { PersonMembersClient, toPersonRpc } from '../person/person-members.client';
import { foldContactSummary, type ContactSummaryFacts } from './contact-summary.fold';
import { statusToWire } from '../shared/wire';

interface PlayerSummaryRequestWire {
  playerId?: string;
  brandId?: string;
}

/**
 * ChatsReadService contact summaries (feature 022, roadmap 4.13) — **"when did we last talk to this
 * customer, and on which channels?"**
 *
 * ── Why this is not a field on the feed ─────────────────────────────────────────────────────────
 * The feed already carries `last_activity_at`, and it is `Conversation.updated_at` — a `@updatedAt`
 * column that relabelling, reassigning or resolving bumps. A card built on it reports our own internal
 * work as customer contact and looks right doing so. These facts come from MESSAGES instead, via two
 * columns maintained in the message write's transaction.
 *
 * An aggregate is also a different kind of answer from a page: attached to a paged response it would be
 * recomputed on every page, and it would invite a caller to read page 1 to learn a total (FR-013).
 *
 * ── Never contacted is an ANSWER ────────────────────────────────────────────────────────────────
 * Absent timestamps are empty strings, never an epoch date — `1970` on a card is a wrong fact rather
 * than a missing one. An unknown player, a player in another account and a genuinely uncontacted player
 * all get the identical populated answer, so nothing here discloses whether a record exists (FR-007 of
 * feature 016's shape, and SC-005 here).
 *
 * Gated by `crm.inbox.view` — the same key as the feed, because these are the same facts in aggregate.
 * The person-level call additionally requires `crm.contact.view`, which is enforced by `users` on the
 * caller's own forwarded credentials when the member list is resolved (see `person/person-members.client.ts`).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ContactSummaryController {
  constructor(
    @Inject(ContactSummaryRepository) private readonly repo: ContactSummaryRepository,
    @Inject(PersonMembersClient) private readonly members: PersonMembersClient,
  ) {}

  @GrpcMethod('ChatsReadService', 'GetPlayerContactSummary')
  @RequiresChatsPermission('crm.inbox.view')
  async getPlayerContactSummary(req: PlayerSummaryRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);

    // An unknown / empty player is the never-contacted answer, never an error that could disclose
    // whether a record exists in this or another account.
    if (!req.playerId) return toWire(foldContactSummary([]));

    // A summary without a brand cannot be answered: GR8's platform id is unique only WITHIN a brand, so
    // the request names two customers. Refused rather than merged — merging is precisely the defect
    // roadmap 5.2 removed, and an aggregate would recreate it one layer up (feature 020 / FR-001).
    if (!req.brandId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'brandId is required to identify a player',
      });
    }

    const groups = await this.repo.groupsForPlayer(ctx.accountId, {
      brandId: req.brandId,
      playerId: req.playerId,
    });
    return toWire(foldContactSummary(groups));
  }

  /**
   * The same facts for one HUMAN, across the brands they were EXPLICITLY linked on (feature 020's
   * `Person`, established from a matching email or phone — never from an id collision).
   *
   * Two rules make this honest, and both are the reason it is not simply "the player call with a wider
   * filter":
   *
   *  1. **Membership comes from `users`, on the CALLER's credentials.** `ListPersonMembers` is gated by
   *     `crm.contact.view`, because knowing that two records are one person is itself a statement about a
   *     customer. The metadata is forwarded unchanged so `users` enforces it; a system-actor call would
   *     launder the key (research R5).
   *  2. **If membership cannot be established, this FAILS.** It does not answer from the members that
   *     happened to resolve, and it does not return "no contact". An aggregate over a subset of a human is
   *     indistinguishable from an aggregate over the human, so nobody would ever investigate it
   *     (FR-022). `MembershipUnavailableError` propagates; a refusal from `users` keeps its own status.
   *
   * The aggregation itself is the SAME single grouped query and the SAME fold as the player level — one
   * implementation, so the two levels cannot drift into describing the same facts differently.
   */
  @GrpcMethod('ChatsReadService', 'GetPersonContactSummary')
  @RequiresChatsPermission('crm.inbox.view')
  async getPersonContactSummary(req: { personId?: string }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!req.personId) return toWire(foldContactSummary([]));

    // An EMPTY membership is a legitimate data state (an unlink can leave a person of one behind, and a
    // person with no members is not an error). An UNREADABLE membership is a failure — the client draws
    // that distinction, and this call must not blur it back together.
    // The failure is TRANSLATED, not allowed to escape: a plain error leaving a Nest gRPC handler becomes
// UNKNOWN, so a caller lacking `crm.contact.view` was told the server had broken (500 instead of 403).
    // Found on the live run — see `toPersonRpc`.
    let members;
    try {
      members = await this.members.membersOf(req.personId, metadata);
    } catch (err) {
      throw toPersonRpc(err);
    }
    const groups = await this.repo.groupsForMembers(ctx.accountId, members);
    return toWire(foldContactSummary(groups));
  }
}

/**
 * Facts → wire. Timestamps are ISO strings, and **absent is the empty string**: proto3 has no null, and
 * a zero timestamp would render as 1 January 1970 — a wrong fact rather than a missing one (FR-008).
 *
 * Exported because the person-level handler serialises the identical shape; one mapper, so the two
 * levels cannot drift into describing the same facts differently.
 */
export function toWire(facts: ContactSummaryFacts) {
  const iso = (d: Date | null) => (d ? d.toISOString() : '');
  return {
    lastInboundAt: iso(facts.lastInboundAt),
    lastOutboundAt: iso(facts.lastOutboundAt),
    lastContactAt: iso(facts.lastContactAt),
    conversationCount: facts.conversationCount,
    countsByStatus: facts.countsByStatus.map((c) => ({
      status: statusToWire(c.status),
      conversationCount: c.conversationCount,
    })),
    channels: facts.channels.map((c) => ({
      channel: c.channel,
      channelUnrecorded: c.channelUnrecorded,
      lastInboundAt: iso(c.lastInboundAt),
      lastOutboundAt: iso(c.lastOutboundAt),
      conversationCount: c.conversationCount,
    })),
  };
}
