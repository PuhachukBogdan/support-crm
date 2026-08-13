import { Inject, Injectable, Logger } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { JwtService } from '@nestjs/jwt';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { USERS_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';

/**
 * Make sure the person who just obtained a session HAS an operator profile (roadmap 5.10, block W1).
 *
 * ── Why the gateway and not auth ─────────────────────────────────────────────────────────────────
 * The two halves live in different services and different databases: `auth` owns the identity,
 * `users` owns the profile that makes a person assignable. **`auth` has no client for `users` and
 * `users` has none for `auth`** — services in this product do not reach sideways (Principle VIII);
 * the gateway is the composition layer and already dials both. Adding an `auth → users` edge to
 * write one row would be the first such edge in the product, and it would put `auth` in the business
 * of another service's schema.
 *
 * ⚠️ **A failure here must NOT fail the sign-in.** The person is authenticated; a missing profile is
 * a repairable state, and refusing the session would turn a follow-up write's outage into "nobody can
 * log in". This is why the call is idempotent and why it is made on **every** login rather than only
 * at registration: whoever registered before this shipped — there are such people on the stand — is
 * repaired the next time they sign in, which is the "named path" roadmap 5.10 asked for instead of a
 * hand-written INSERT.
 *
 * ⚠️ **The identity comes from the freshly minted token, verified the same way every request is.**
 * The gateway verifies JWTs locally against the shared secret (`AuthGuard`, Principle VII) — so the
 * claims used here are proven, not asserted by the body of a public request.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

interface OperatorProfileGrpc {
  ensureOwnOperator(
    data: Record<string, never>,
    metadata?: Metadata,
  ): Observable<{ operatorId: string; accountId: string; active: boolean }>;
}

@Injectable()
export class EnsureOperatorProfile {
  private readonly log = new Logger(EnsureOperatorProfile.name);
  private profiles?: OperatorProfileGrpc;

  constructor(
    @Inject(USERS_CLIENT) private readonly client: ClientGrpc,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  private svc(): OperatorProfileGrpc {
    this.profiles ??= this.client.getService<OperatorProfileGrpc>('OperatorProfileService');
    return this.profiles;
  }

  /**
   * Best-effort, never throwing. Returns the operator id when one was obtained — callers use it for
   * diagnostics only; no response body depends on it, so a slow or dead `users` cannot change what a
   * signing-in person receives.
   */
  async fromAccessToken(accessToken: string | undefined): Promise<string | undefined> {
    if (!accessToken) return undefined;

    let accountId: string;
    let userId: string;
    try {
      const p = this.jwt.verify<{ sub: string; account_id: string }>(accessToken, {
        secret: this.cfg.JWT_SECRET,
      });
      accountId = p.account_id;
      userId = p.sub;
    } catch {
      // A token we just minted failing verification is a configuration fault, not a user error. It is
      // logged rather than raised: the session itself is already valid to the client.
      this.log.warn('operator profile skipped: freshly issued token did not verify');
      return undefined;
    }
    if (!accountId || !userId) {
      this.log.warn('operator profile skipped: token carried no account or subject');
      return undefined;
    }

    const md = new Metadata();
    md.set('x-actor-account-id', accountId);
    md.set('x-actor-user-id', userId);

    try {
      const res = await firstValueFrom(this.svc().ensureOwnOperator({}, md));
      return res?.operatorId;
    } catch (err) {
      // Deliberately swallowed. The next sign-in tries again, and the point's own repair path is
      // exactly this call — so an outage postpones the profile, it does not lose it.
      this.log.warn(
        `operator profile could not be ensured for this session: ${(err as Error)?.message ?? 'unknown'}`,
      );
      return undefined;
    }
  }
}
