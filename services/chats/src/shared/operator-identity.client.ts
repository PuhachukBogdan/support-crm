import { Inject, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { grpcClientOptions, USERS_PACKAGE, USERS_PROTO } from '@crm/common';

/**
 * chats → users: **which operator is the CALLER** (roadmap 5.11 server half, MVP block W5).
 *
 * ── The gap this closes, on this side of the wire ─────────────────────────────────────────────────
 * Assignments point at `users.Operator.id`; the metadata the gateway forwards carries only the auth
 * identity. Everything in chats that needs "the caller, as an operator" — the read mark under the
 * agent rail (4.19) — lands here. The only other translation (`ListOperatorsByAuthUsers`) is gated by
 * a staffing permission an ordinary agent does not hold, and forwarding a SYSTEM actor to dodge that
 * would be exactly the permission laundering feature 022 forbids. This call forwards the caller's own
 * validated identity headers and asks a question only they can be the subject of.
 *
 * ── Why the far side is `EnsureOwnOperator` and not a getter ─────────────────────────────────────
 * The .proto decided this in W1: one self-scoped surface, "the shape roadmap 5.11 requires", rather
 * than a second rpc answering the same question. Ensure-on-a-read-path is safe HERE specifically:
 * the write branch is practically dead (every caller signed in, and the login tail already ensured
 * the profile), it is idempotent by unique constraint, and if it ever does fire it REPAIRS a missing
 * profile rather than corrupting anything. A second read-only rpc would exist purely so this comment
 * could be shorter.
 *
 * ── The cache, and why "for ever" is correct rather than lazy ────────────────────────────────────
 * The mapping (account, auth user) → operator id is written once and never changes: the upsert keys
 * on that pair and nothing updates the id. So entries never go stale by construction, and the only
 * bound needed is size (an LRU-ish cap against tenant churn). One users hop per (account, user) per
 * process lifetime; every detail open after that costs a Map lookup.
 *
 * ── Failure is an ABSENCE, never an error ─────────────────────────────────────────────────────────
 * A detail read must not fail because identity translation hiccuped — the caller asked for a
 * conversation, not for themselves. `null` means "no operator identity right now": the mark is simply
 * not written, and the next read tries again. The class is logged, the ids are not.
 */

export const CHATS_OPERATOR_IDENTITY_CLIENT = 'CHATS_OPERATOR_IDENTITY_CLIENT';

/** Entries are immutable facts; the cap only bounds memory, it never refreshes anything. */
const CACHE_CAP = 10_000;

interface OperatorProfileGrpc {
  ensureOwnOperator(
    d: Record<string, never>,
    md?: Metadata,
  ): Observable<{ operatorId?: string }>;
}

function readStr(md: Metadata | undefined, key: string): string {
  const raw = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

@Injectable()
export class OperatorIdentityClient implements OnModuleInit {
  private readonly logger = new Logger(OperatorIdentityClient.name);
  private profiles!: OperatorProfileGrpc;
  private readonly cache = new Map<string, string>();

  constructor(@Inject(CHATS_OPERATOR_IDENTITY_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.profiles = this.client.getService<OperatorProfileGrpc>('OperatorProfileService');
  }

  /**
   * The CALLER's operator id, from the incoming request metadata — or `null` when it cannot be known
   * right now. The subject is whoever the gateway validated; there is no argument to point elsewhere.
   */
  async resolveCallerOperatorId(incoming: Metadata | undefined): Promise<string | null> {
    const accountId = readStr(incoming, 'x-actor-account-id');
    const userId = readStr(incoming, 'x-actor-user-id');
    // A machine caller (worker tick) has no user — and no rail. An honest nothing, not an error.
    if (!accountId || !userId) return null;

    const key = `${accountId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    // ⚠️ ONLY the two identity headers travel. Permissions are deliberately not forwarded: the far
    // side reads none, and a header nobody reads is the `x-actor-role` lesson — an input that looks
    // load-bearing to the next reader.
    const md = new Metadata();
    md.set('x-actor-account-id', accountId);
    md.set('x-actor-user-id', userId);

    try {
      const res = await firstValueFrom(this.profiles.ensureOwnOperator({}, md));
      const operatorId = typeof res?.operatorId === 'string' ? res.operatorId : '';
      if (!operatorId) return null;

      if (this.cache.size >= CACHE_CAP) {
        // Map iterates in insertion order; dropping the oldest entry is enough of an LRU for a value
        // that is immutable anyway — eviction costs one extra hop, never a wrong answer.
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, operatorId);
      return operatorId;
    } catch (err) {
      // The CLASS, never the ids (Principle IV). `null` is contained: the read this rode on proceeds.
      this.logger.warn(
        `operator identity unresolved class=${err instanceof Error ? err.name : 'unknown'}`,
      );
      return null;
    }
  }
}

/**
 * Its own client provider, like `ChatsChannelParticipantModule` and `ChatsPersonModule` beside it:
 * this channel carries an empty message and two headers, and tying it to the participant channel
 * would couple the rail's identity lookup to whatever limits the envelope path needs next.
 *
 * No new configuration — `USERS_GRPC_TARGET` is already a refuse-to-start requirement.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CHATS_OPERATOR_IDENTITY_CLIENT,
        useFactory: () =>
          grpcClientOptions(USERS_PACKAGE, USERS_PROTO, process.env.USERS_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [OperatorIdentityClient],
  exports: [OperatorIdentityClient],
})
export class ChatsOperatorIdentityModule {}
