import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, RpcException, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import {
  decodeWireState,
  grpcClientOptions,
  USERS_PACKAGE,
  USERS_PROTO,
  type PresenceState,
} from '@crm/common';

/**
 * chats → users: **which brand-scoped records make up one human** (feature 022, roadmap 4.13).
 *
 * ── The call feature 020 designed and never made ────────────────────────────────────────────────
 * Feature 020 settled that a human spanning brands is an EXPLICITLY linked `Person` — established from a
 * matching email or phone, never from an id collision — and stored the link in `users_db`. It shipped
 * `ListPersonMembers` and declared `ChatsReadService.GetPersonFeed`. Nothing connected them: the rpc had
 * no handler and the users call had no caller, for a whole roadmap point. The users proto had even named
 * the intended caller: *"Chats needs it to answer a person's conversation feed … the same way chats
 * already dials this service for uploads."*
 *
 * ── The permission, and why it is not the inbox key ─────────────────────────────────────────────
 * `ListPersonMembers` is gated by **`crm.contact.view`**, and the users controller says why: knowing that
 * two records are one person is itself a statement about a customer, even with no value attached. So the
 * caller's own metadata is forwarded UNCHANGED and `users` enforces it. Calling as a system actor would
 * launder the permission — an inbox-only caller would learn through the person feed exactly what the
 * contact key exists to gate (research R5). There is no dead end: the card learns the person id from
 * `GetPlayer`, which is also `crm.contact.view`.
 *
 * ── Fail-closed, deliberately ───────────────────────────────────────────────────────────────────
 * Unreachable, or a response we cannot read ⇒ {@link MembershipUnavailableError}. The caller must FAIL,
 * never answer from the members that happened to resolve: an aggregate over a subset of a human looks
 * exactly like an aggregate over the human, and nobody would ever investigate it. Same rule, same reason
 * as `auth/auth.client.ts` (`AuthorityUnavailableError`) — an unavailable source and a genuine "nothing"
 * are indistinguishable unless one of them is an error.
 *
 * No new configuration: `USERS_GRPC_TARGET` is already a refuse-to-start requirement in `config.ts`
 * (feature 016), and this is the second consumer of it.
 */

export const CHATS_PERSON_CLIENT = 'CHATS_PERSON_CLIENT';

/** The person's membership could not be established. Callers must refuse, never narrow. */
export class MembershipUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`person membership unavailable: ${detail}`);
    this.name = 'MembershipUnavailableError';
  }
}

/** One member record: a customer is `(brand, player)` — a platform id alone names two people. */
export interface MemberIdentity {
  brandId: string;
  playerId: string;
}

/**
 * Normalise a membership failure into an RpcException **that keeps its status**.
 *
 * ⚠️ **Found on the live run: without this, a refusal arrived as a 500.** `users` gates
 * `ListPersonMembers` with `crm.contact.view` and answers PERMISSION_DENIED; the client rethrows it, and a
 * plain error escaping a Nest gRPC handler becomes UNKNOWN — which the gateway correctly maps to 500. So a
 * caller who simply lacks a permission was told the server had broken. Feature 012's Track B found the same
 * class ("a correctly-NOT_FOUND cross-account read surfaced as 500 + stack trace"), and the Track-A test
 * here could not see it: it asserted the call REJECTED, never which status the service then emitted.
 *
 * The status is preserved rather than flattened — 403 must stay 403, because "you may not ask this" and
 * "the identity source is down" are different facts and only one of them is the caller's to fix. The
 * MESSAGE never comes from downstream (SEC-26): no person id, no address, no response body.
 */
export function toPersonRpc(err: unknown): RpcException {
  if (err instanceof RpcException) return err;
  if (err instanceof MembershipUnavailableError) {
    return new RpcException({ code: GrpcStatus.UNAVAILABLE, message: 'identity unavailable' });
  }
  const code = (err as { code?: number })?.code;
  if (typeof code === 'number') {
    return new RpcException({ code, message: code === GrpcStatus.PERMISSION_DENIED ? 'forbidden' : 'identity unavailable' });
  }
  return new RpcException({ code: GrpcStatus.UNAVAILABLE, message: 'identity unavailable' });
}

interface PlayerRefWire {
  brandId?: string;
  playerId?: string;
}

/** One member of a group, translated from an auth identity to someone who can hold work. */
export interface AssignableOperator {
  operatorId: string;
  authUserId: string;
  /**
   * Feature 025 (roadmap 5.9). `online` | `transfers_only` | `away` | `offline`.
   *
   * ⚠️ NOT the same fact as having an active profile. `users` already excluded deactivated staff
   * before answering — that person has LEFT. This says whether the person who is still employed is
   * at their desk right now. Both make somebody unavailable and they are not interchangeable.
   */
  state: PresenceState;
  /** ONLY the channels switched OFF. Absence means available (FR-019). */
  blockedChannels: string[];
}

interface ResolvedOperatorWire {
  operatorId?: string;
  authUserId?: string;
  state?: number | string;
  blockedChannels?: string[];
}

/**
 * Wire enum → domain state, fail-closed.
 *
 * ⚠️ An unreadable value becomes `offline`, NOT `online`. The two wrong answers are not symmetric:
 * defaulting to available pushes a live customer at somebody who may be asleep, while defaulting to
 * unavailable merely declines to route to one person. When a decoder cannot tell, it must pick the
 * direction that fails safely — the same rule the REST edge applies to unknown enum values.
 */
const decodeState = (raw: unknown): PresenceState => decodeWireState(raw) ?? 'offline';

interface AssignmentWire {
  brandId?: string;
  playerId?: string;
}

interface UsersReadGrpc {
  listPersonMembers(
    d: { personId: string },
    md?: Metadata,
  ): Observable<{ members?: PlayerRefWire[] }>;
  listOperatorsByAuthUsers(
    d: { accountId: string; authUserIds: string[] },
    md?: Metadata,
  ): Observable<{ operators?: ResolvedOperatorWire[] }>;
  listAssignedPlayers(
    d: { amAuthUserId: string; pageSize: number; pageToken: string },
    md?: Metadata,
  ): Observable<{ assignments?: AssignmentWire[]; nextPageToken?: string }>;
}

/**
 * How many portfolio pages this client will follow before refusing (feature 030, research R5).
 *
 * ⚠️ **A truncated portfolio HIDES conversations, with nothing on screen saying so.** That is why the
 * ceiling refuses instead of returning what it has: *"your portfolio is too large to display"* is a bad
 * day, *"eleven of your players are invisible and nobody mentioned it"* is an incident. The bound also
 * makes the spec's assumption — tens of players, not thousands — checkable instead of implied.
 */
const PORTFOLIO_PAGE_SIZE = 200;
const PORTFOLIO_MAX_PAGES = 10;

@Injectable()
export class PersonMembersClient implements OnModuleInit {
  private users!: UsersReadGrpc;

  constructor(@Inject(CHATS_PERSON_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.users = this.client.getService<UsersReadGrpc>('UsersReadService');
  }

  /**
   * The person's linked member records.
   *
   * @param metadata the CALLER's own metadata — forwarded unchanged so `users` evaluates
   *                 `crm.contact.view` against the real actor, not against this service.
   * @throws MembershipUnavailableError when the answer cannot be established.
   *         A gRPC refusal (any status) is rethrown as-is, so a 403 stays a 403.
   */
  async membersOf(personId: string, metadata: Metadata): Promise<MemberIdentity[]> {
    // Nothing to ask about: the answer is the same empty membership the wire would return, one round trip
    // cheaper. Deliberately NOT an error — an absent id is a caller-shaped mistake, not a person with a
    // broken link.
    if (!personId) return [];

    let res: { members?: PlayerRefWire[] };
    try {
      res = await firstValueFrom(this.users.listPersonMembers({ personId }, metadata));
    } catch (err) {
      // A refusal from users carries a gRPC status code and is rethrown so the caller maps it (a 403 must
      // stay a 403, never become "this person has no members"). Anything else is the transport.
      if (typeof (err as { code?: number })?.code === 'number') throw err;
      // NEVER the person id, the response body or the target address (Principle IV / SEC-26).
      throw new MembershipUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }

    // An ABSENT `members` field is not an empty list. Absent data and no data look identical on the wire,
    // and treating the first as the second is how a person-level read would quietly narrow to nothing.
    if (!res || !Array.isArray(res.members)) {
      throw new MembershipUnavailableError('unreadable response');
    }

    // Half an identity identifies nobody. Dropped rather than forwarded, because a member with no brand
    // would select rows by `player_id` alone — the exact merge roadmap 5.2 removed.
    return res.members
      .filter((m): m is Required<PlayerRefWire> => !!m?.brandId && !!m?.playerId)
      .map((m) => ({ brandId: m.brandId, playerId: m.playerId }));
  }

  /**
   * Translate AUTH user ids into ASSIGNABLE operator profiles (feature 024, roadmap 5.3).
   *
   * Group membership is keyed on the auth identity; a conversation's assignee is an operator profile.
   * This is that translation, and it is an explicit call because the two live in different databases
   * (Principle VIII). Only ACTIVE profiles come back, so a member who cannot hold work is simply
   * absent — and the caller can compare what it asked for with what it got.
   *
   * ⚠️ **`users` returning FEWER than asked is normal; users failing is not.** The first is a fact
   * about staffing, the second is an absence of information, and if this method returned `[]` for
   * both, an unreachable users service would look exactly like "this desk has nobody" — routing would
   * stop for a whole team with every request still answering 200.
   *
   * @param metadata the CALLER's own metadata, forwarded unchanged so `users` evaluates
   *                 `crm.conversation.assign` against the real actor. Calling as a system actor would
   *                 launder the permission — the rule feature 022 established one field over.
   * @throws MembershipUnavailableError when the answer cannot be established; a gRPC refusal is
   *         rethrown as-is so a 403 stays a 403.
   */
  /**
   * The CALLER's own attached players — their portfolio (feature 030, roadmap 4.14).
   *
   * ⭐ **`amAuthUserId` is sent EMPTY on purpose, and that is the whole design.** The users contract
   * defines empty as *"the CALLING manager's own portfolio"* and requires `users.list.view` only to name
   * **somebody else** — *"show me another manager's book of business"* is a supervisory question, not a
   * self-service one. So this read needs no extra permission, and there is nothing to launder: the
   * subject is not a parameter, so it cannot be pointed at anyone.
   *
   * ⚠️ **A member is `(brand, player)`, never a bare `player_id`.** Since feature 020 the same platform
   * id under two brands is routinely two different human beings — matching on the id alone would put
   * another person's conversations in this AM's queue, which is the collision ADR 0038 §3 already had to
   * fix once. Half an identity is dropped rather than forwarded, exactly as {@link membersOf} does.
   *
   * ⚠️ **Paginated, and exhausted here.** See {@link PORTFOLIO_MAX_PAGES}: a partial portfolio is a
   * narrowing that is too NARROW, which is worse than too wide because nothing tells the agent.
   *
   * @param metadata the CALLER's own metadata, forwarded unchanged so `users` answers for the real actor.
   * @throws MembershipUnavailableError when the portfolio cannot be established — the caller must refuse
   *         the read rather than answer from an unnarrowed list. A gRPC refusal is rethrown as-is so a
   *         403 stays a 403.
   */
  async attachedPlayersOfCaller(metadata: Metadata): Promise<MemberIdentity[]> {
    const out: MemberIdentity[] = [];
    let pageToken = '';

    for (let page = 0; page < PORTFOLIO_MAX_PAGES; page++) {
      let res: { assignments?: AssignmentWire[]; nextPageToken?: string };
      try {
        res = await firstValueFrom(
          this.users.listAssignedPlayers(
            // Empty subject = "me". Never this service's identity, never a parameter.
            { amAuthUserId: '', pageSize: PORTFOLIO_PAGE_SIZE, pageToken },
            metadata,
          ),
        );
      } catch (err) {
        if (typeof (err as { code?: number })?.code === 'number') throw err;
        // NEVER the caller, the page token or the target address (Principle IV / SEC-26).
        throw new MembershipUnavailableError(err instanceof Error ? err.name : 'rpc failed');
      }

      // proto3 omits an empty repeated field, so an ABSENT list means "no attachments" — a real answer.
      // A non-array is a response we cannot read, and reading it as "none" would silently empty a queue.
      const rows = res?.assignments;
      if (rows !== undefined) {
        if (!Array.isArray(rows)) throw new MembershipUnavailableError('unreadable response');
        for (const row of rows) {
          if (row?.brandId && row.playerId) out.push({ brandId: row.brandId, playerId: row.playerId });
        }
      }

      pageToken = typeof res?.nextPageToken === 'string' ? res.nextPageToken : '';
      if (!pageToken) return out;
    }

    // Still more pages after the ceiling: refuse rather than narrow to a subset (research R5).
    throw new MembershipUnavailableError('portfolio exceeds page ceiling');
  }

  async resolveOperators(
    accountId: string,
    authUserIds: readonly string[],
    metadata: Metadata,
  ): Promise<AssignableOperator[]> {
    const ids = [...new Set(authUserIds.filter((id) => id))];
    // Nobody to translate. Not an error: an empty group is a legitimate answer that the caller turns
    // into "group routing not available".
    if (ids.length === 0) return [];

    let res: { operators?: ResolvedOperatorWire[] };
    try {
      res = await firstValueFrom(
        this.users.listOperatorsByAuthUsers({ accountId, authUserIds: ids }, metadata),
      );
    } catch (err) {
      if (typeof (err as { code?: number })?.code === 'number') throw err;
      throw new MembershipUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }

    // proto3 omits an empty repeated field, so an ABSENT list here genuinely means "none of them has
    // an active profile" — a real answer. `null` or a non-array is a response we cannot read.
    const rows = res?.operators;
    if (rows === undefined) return [];
    if (!Array.isArray(rows)) throw new MembershipUnavailableError('unreadable response');

    return rows
      .filter((o): o is ResolvedOperatorWire => !!o?.operatorId && !!o?.authUserId)
      .map((o) => ({
        operatorId: o.operatorId as string,
        authUserId: o.authUserId as string,
        state: decodeState(o.state),
        blockedChannels: Array.isArray(o.blockedChannels) ? o.blockedChannels.map(String) : [],
      }));
  }
}

/**
 * Registers the users client used for person membership.
 *
 * A SEPARATE provider from `ChatsUploadsModule` even though both dial `users`: the uploads channel raises
 * its message-size ceiling for attachment bytes, and this call carries a handful of ids. Sharing the
 * channel would tie an identity read's limits to whatever the byte path needs next.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CHATS_PERSON_CLIENT,
        useFactory: () =>
          grpcClientOptions(USERS_PACKAGE, USERS_PROTO, process.env.USERS_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [PersonMembersClient],
  exports: [PersonMembersClient],
})
export class ChatsPersonModule {}
