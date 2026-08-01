import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, resolveBrandIn } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import { toSummaryWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';
import { PersonMembersClient } from '../person/person-members.client';

interface GetPlayerFeedRequestWire {
  playerId: string;
  /** Required since feature 020 — a platform id alone names two customers, not one. */
  brandId?: string;
  projection?: string;
  pageToken?: string;
  pageSize?: number;
}

/** Feature 022 — the cross-brand HUMAN, whose membership comes from `users` and never from an id match. */
interface GetPersonFeedRequestWire {
  personId: string;
  projection?: string;
  pageToken?: string;
  pageSize?: number;
}

/**
 * ChatsReadService.GetPlayerFeed (feature 012, US3) — one chronological feed of ONE brand's player.
 *
 * ⚠️ **THIS IS WHERE THE DEFECT LIVED, and it shipped with a passing live test** (roadmap 4.3:
 * *"one `player_id` merges 2 brands in one stream"*). The feed used to merge conversations across
 * every brand the id appeared under — "brand-union" — on the belief that one `player_id` is one
 * person. GR8's `player_id` is unique only WITHIN a brand, so wherever the platform reuses one, that
 * merge showed an agent **another customer's conversations**. The test proved the merge happened; it
 * could not prove the merge was right, because correctness depended on a fact about GR8 that was in
 * no document at the time.
 *
 * The feed now keys on the full identity. A human who genuinely plays under several brands is a
 * **Person** (`GetPersonFeed`), established from a matching email or phone — never from an id match.
 *
 * Account isolation is unchanged (`forAccount`, Principle I). Brand takes no part in authorization
 * (ADR 0038 §1: one support department serves every brand) — it is identity here, nothing more.
 *
 * Summaries only, no message bodies, so no private-note content is exposed here by construction
 * (SEC-13 stays a thread concern).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class FeedReadController {
  constructor(
    @Inject(ConversationRepository) private readonly repo: ConversationRepository,
    // Feature 022: identity crosses as an explicit call — `chats` cannot join `users_db` (Principle VIII)
    // and never derives a person itself.
    @Inject(PersonMembersClient) private readonly members: PersonMembersClient,
  ) {}

  @GrpcMethod('ChatsReadService', 'GetPlayerFeed')
  @RequiresChatsPermission('crm.inbox.view')
  async getPlayerFeed(req: GetPlayerFeedRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    // Unknown / empty player → empty feed (never an error that could disclose cross-account existence).
    if (!req.playerId) return { conversations: [], nextPageToken: '' };

    // A feed without a brand cannot be answered: the platform id names two customers. Refused rather
    // than merged — merging is precisely the defect (FR-003). An EMPTY brand counts as absent.
    if (!req.brandId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'brandId is required to identify a player',
      });
    }

    let cursor;
    try {
      cursor = decodeCursor(req.pageToken);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw e;
    }

    const { rows, nextCursor } = await this.repo.list(ctx.accountId, {
      playerId: req.playerId,
      // ONE brand — the player's own. `resolveBrandIn` still applies the caller's request the way every
      // other list does; what changed is that the brand is no longer `undefined` here, so the query can
      // no longer widen to "every brand this id appears under".
      brandIn: resolveBrandIn(ctx, req.brandId),
      limit: clampPageSize(req.pageSize),
      cursor,
    });
    return {
      conversations: rows.map(toSummaryWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }

  /**
   * ChatsReadService.GetPersonFeed — **the conversations of one HUMAN, across the brands they were
   * explicitly linked on** (feature 022 implementing feature 020's declaration, roadmap 4.13 / 5.2).
   *
   * ⚠️ **This rpc was declared by feature 020 and served by NOTHING** — no handler, no gateway route, no
   * test — while `users.ListPersonMembers` sat on the other side with no caller. Two halves of one
   * unbuilt call, and nothing failed, because `chats` had no guard asserting that a declared rpc is
   * served. It has one now (`tests/contracts/every-rpc-is-served.spec.ts`), which is how the same defect
   * was found in `auth` as well.
   *
   * A DIFFERENT question from `GetPlayerFeed`, and deliberately a different call: one asks "what has this
   * ACCOUNT written to us", the other "what has this PERSON written to us". Membership comes from `users`
   * — `chats` never derives a person, and never from a matching platform id (that merge WAS the 5.2
   * defect). Each returned row still carries its own brand: the union never hides where a row came from.
   *
   * One query over the union, keyset-paged exactly as the player feed is (research R6). If the membership
   * cannot be established the call FAILS: an aggregate over the members that happened to resolve would be
   * a statement about a subset of a human, wearing the shape of a statement about the human.
   */
  @GrpcMethod('ChatsReadService', 'GetPersonFeed')
  @RequiresChatsPermission('crm.inbox.view')
  async getPersonFeed(req: GetPersonFeedRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    // Unknown / empty person → empty feed, never an error that could disclose cross-account existence
    // (the same rule the player feed applies to an unknown player).
    if (!req.personId) return { conversations: [], nextPageToken: '' };

    let cursor;
    try {
      cursor = decodeCursor(req.pageToken);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw e;
    }

    // The caller's OWN metadata goes to users, which enforces `crm.contact.view` on it: knowing that two
    // records are one person is a statement about a customer. A system-actor call would launder that key.
    const members = await this.members.membersOf(req.personId, metadata);

    const { rows, nextCursor } = await this.repo.list(ctx.accountId, {
      // `[]` (a person with no members) yields an empty page — never an unfiltered one.
      membersIn: members,
      limit: clampPageSize(req.pageSize),
      cursor,
    });
    return {
      conversations: rows.map(toSummaryWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }
}
