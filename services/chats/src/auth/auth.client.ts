import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_PACKAGE, AUTH_PROTO, grpcClientOptions } from '@crm/common';

/**
 * chats → auth: resolve a rule author's **current** effective permissions (feature 014, FR-023 /
 * research R5). The first cross-service edge out of chats; acyclic (auth never calls chats).
 *
 * ── Why live, and why no cache ───────────────────────────────────────────────────────────────────
 * An automation rule acts with its AUTHOR's authority, re-resolved on every evaluation. That was the
 * operator's decision (spec Q1 → option A) and it is the only option needing no second mechanism:
 * revoking a permission through Access Management also stops that person's rules, immediately, with
 * nothing to invalidate and no frozen privilege left behind.
 *
 * So there is deliberately **no cross-request cache here**. Rule evaluation is event-driven, not a
 * user request path, so the extra hop is not on a latency budget (Principle VII), and with no cache
 * there is no stale window to reason about — SC-011 holds by construction. The engine memoises the
 * result within a single evaluation pass (several rules by one author ⇒ one call). If volume ever
 * demands more, the gateway's `EffectivePermsCache` (30 s TTL + explicit invalidation on privilege
 * change) is the ready-made pattern to adopt — as an optimisation with a known invalidation
 * contract, never as a silent default.
 *
 * ── Fail-closed (FR-024) ────────────────────────────────────────────────────────────────────────
 * Auth unreachable, user unknown, or a response we cannot read ⇒ {@link AuthorityUnavailableError}.
 * The caller REFUSES the rule and records why. A rule is never applied on assumed authority, and an
 * empty permission list is never returned as a successful "this author may do nothing" — those two
 * outcomes look identical to a naive caller and only one of them is safe to treat as a decision.
 */

export const CHATS_AUTH_CLIENT = 'CHATS_AUTH_CLIENT';

/** The author's authority could not be established. Callers must refuse, never assume. */
export class AuthorityUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(`author authority unavailable: ${detail}`);
    this.name = 'AuthorityUnavailableError';
  }
}

interface ResolveResponseWire {
  roleKey?: string;
  permissionKeys?: string[];
}

interface ListGroupMembersWire {
  /** Feature 031: proto3 omits a false bool, so absent means NOT routable. */
  routable?: boolean;
  userIds?: string[];
}

interface AuthGrpc {
  resolveEffectivePermissions(data: {
    accountId: string;
    userId: string;
    previewRole: string;
  }): Observable<ResolveResponseWire>;
  listGroupMembers(data: { accountId: string; groupId: string }): Observable<ListGroupMembersWire>;
}

export interface AuthorResolution {
  roleKey: string;
  permissionKeys: string[];
}

@Injectable()
export class AuthorAuthorityClient implements OnModuleInit {
  private auth!: AuthGrpc;

  constructor(@Inject(CHATS_AUTH_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.auth = this.client.getService<AuthGrpc>('AuthService');
  }

  /**
   * Resolve `userId`'s current effective permissions inside `accountId`.
   * @throws AuthorityUnavailableError when authority cannot be established (fail-closed).
   */
  async resolve(accountId: string, userId: string): Promise<AuthorResolution> {
    if (!accountId || !userId) {
      // An authorless rule (e.g. a row predating the author column) must refuse, not run.
      throw new AuthorityUnavailableError('missing author identity');
    }
    let res: ResolveResponseWire;
    try {
      res = await firstValueFrom(
        this.auth.resolveEffectivePermissions({ accountId, userId, previewRole: '' }),
      );
    } catch (err) {
      // Reason class only — never the account/user id or any response body (Principle IV / SEC-26).
      throw new AuthorityUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }
    const keys = res?.permissionKeys;
    if (!Array.isArray(keys)) {
      throw new AuthorityUnavailableError('unreadable response');
    }
    // NOTE: an empty array IS a valid answer here ("this author currently holds nothing"), and the
    // engine turns it into a refusal per action. What must never happen is treating an *unreadable*
    // or *failed* resolution as an empty set — hence the checks above rather than a `?? []`.
    return { roleKey: res.roleKey ?? '', permissionKeys: keys };
  }

  /**
   * The AUTH user ids belonging to a group — the candidate pool auto-assignment has been waiting for
   * since feature 013 answered `GROUP_ROUTING_NOT_AVAILABLE` (roadmap 5.3, ADR 0039 §5.3).
   *
   * ⚠️ **An empty list and a failed call must never look alike.** An empty group is a FACT the caller
   * acts on — it answers "group routing not available" and assigns nobody. An unreachable auth is an
   * absence of information, and treating it as "this desk has nobody" would silently stop routing for
   * a whole team while every request still returned 200. So this raises, exactly as `resolve` above
   * does, and for the same reason `person-members.client.ts` raises rather than narrowing.
   *
   * @throws AuthorityUnavailableError when the membership cannot be established (fail-closed).
   */
  async listGroupMembers(accountId: string, groupId: string): Promise<GroupDesk> {
    if (!accountId || !groupId) throw new AuthorityUnavailableError('missing group identity');
    let res: ListGroupMembersWire;
    try {
      res = await firstValueFrom(this.auth.listGroupMembers({ accountId, groupId }));
    } catch (err) {
      // Reason class only — never the account/group id (Principle IV / SEC-26).
      throw new AuthorityUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }
    const ids = res?.userIds;
    // proto3 omits an empty repeated field, so `undefined` here is the normal shape of "no members".
    // An unreadable response is a different thing and is caught by the array check.
    // ⚠️ Feature 031: `routable` is read BEFORE the members check, because a desk that is not fed by the
    // router is not routable whether it has members or not — and answering "no members" for it would send
    // an administrator looking at staffing instead of at the desk's setting.
    // proto3 omits a false bool, so an absent value means NOT routable: the safe direction, and the same
    // answer the column's default gives.
    const routable = res?.routable === true;
    if (ids === undefined || ids === null) return { userIds: [], routable };
    if (!Array.isArray(ids)) throw new AuthorityUnavailableError('unreadable response');
    return { userIds: ids.filter((id) => typeof id === 'string' && id !== ''), routable };
  }
}

/**
 * A desk, as far as routing is concerned: who staffs it, and whether the router may feed it.
 *
 * ⚠️ Both facts in one answer on purpose. Two calls would let them describe different moments — a desk
 * switched off between them would look staffed and routable when it is neither.
 */
export interface GroupDesk {
  userIds: string[];
  routable: boolean;
}

/** Registers the auth client for chats. `AUTH_GRPC_TARGET` is validated at boot (SEC-6). */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CHATS_AUTH_CLIENT,
        useFactory: () =>
          grpcClientOptions(AUTH_PACKAGE, AUTH_PROTO, process.env.AUTH_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [AuthorAuthorityClient],
  exports: [AuthorAuthorityClient],
})
export class ChatsAuthModule {}
