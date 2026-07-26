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

interface AuthGrpc {
  resolveEffectivePermissions(data: {
    accountId: string;
    userId: string;
    previewRole: string;
  }): Observable<ResolveResponseWire>;
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
