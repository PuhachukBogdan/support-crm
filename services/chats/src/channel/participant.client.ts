import { Inject, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ClientsModule, type ClientGrpc } from '@nestjs/microservices';
import { Metadata } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import { grpcClientOptions, USERS_PACKAGE, USERS_PROTO } from '@crm/common';

/**
 * chats → users: **who wrote, and where to write back** (feature 033, roadmap 6.4 — research R9/R10).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THE LOAD-BEARING DECISION OF THIS FEATURE LIVES ON THE OTHER END OF THIS CALL.**
 *
 * Answering an email needs the address the customer wrote **from** — which a salted hash cannot give,
 * and which the player's registered address must not supply either: a player may write from a second
 * address, and answering the registered one would send a stranger's conversation to them.
 *
 * So the envelope is stored by `users`, the service that already owns contact values, holds the hash
 * salt and classifies every such field under the tier policy (FR-021b). **chats never holds an
 * address.** It sends one across this hop, receives an opaque handle, and stores the handle. There is
 * no column in `chats_db` a contact value could go into — `tests/channels/constraints-033.spec.ts`
 * asserts that, so the property survives the next schema edit.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── Why the VALUE crosses the wire rather than the hash ─────────────────────────────────────────
 * `CONTACT_HASH_SALT` is required at users' boot. Copying it into chats so chats could hash locally
 * would put a secret in a second service purely to avoid one in-cluster hop of a value that service
 * already owns. Sending the value to its owner is strictly better than distributing the key that
 * protects it (research R10). The value is logged on neither side.
 *
 * ── `x-actor-kind: system`, and why that is not permission laundering here ──────────────────────
 * `person-members.client.ts` forwards the CALLER's own metadata and says why: calling as a system actor
 * would launder `crm.contact.view`. That rule protects a **human read** — an operator learning
 * something about a customer they may not ask about.
 *
 * This caller is not a human and there is no permission to launder: an arriving email has no session,
 * no operator and no role. The gate on the far side is therefore the actor **kind** (the rpc lives on
 * `UsersMaintenanceService`, which no gateway route reaches), and the account is in the REQUEST because
 * a machine has none of its own.
 */

export const CHATS_PARTICIPANT_CLIENT = 'CHATS_PARTICIPANT_CLIENT';

/** The identity source could not be reached at all — distinct from "it found nobody". */
export class IdentitySourceUnavailableError extends Error {
  constructor(detail: string) {
    super(`identity source unavailable: ${detail}`);
    this.name = 'IdentitySourceUnavailableError';
  }
}

export interface ResolvedParticipant {
  /** The opaque handle chats stores on the conversation. Never an address. */
  participantId: string;
  /** Empty = UNIDENTIFIED. A real answer, and intake proceeds regardless (FR-023). */
  playerId: string;
  /** More than one candidate matched: left unidentified rather than attached to either (FR-022). */
  ambiguous: boolean;
}

interface ParticipantWire {
  participantId?: string;
  playerId?: string;
  ambiguous?: boolean;
}

interface UsersMaintenanceGrpc {
  resolveChannelParticipant(
    d: {
      accountId: string;
      brandId: string;
      channelKind: string;
      kind: string;
      value: string;
    },
    md?: Metadata,
  ): Observable<ParticipantWire>;
}

@Injectable()
export class ChannelParticipantClient implements OnModuleInit {
  private machine!: UsersMaintenanceGrpc;

  constructor(@Inject(CHATS_PARTICIPANT_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.machine = this.client.getService<UsersMaintenanceGrpc>('UsersMaintenanceService');
  }

  /**
   * Register where to answer, and learn who wrote — in one call.
   *
   * ⚠️ **Throws when users is UNREACHABLE, and returns an unidentified answer when users found nobody.**
   * Those are two different facts and the difference decides whether a customer's message survives:
   *
   *   • *Found nobody* ⇒ `{ playerId: '' }`. The ticket is created, complete, and explicitly
   *     unidentified. FR-023 is absolute that identity never blocks intake.
   *   • *Cannot ask* ⇒ throw. The caller refuses the intake **before claiming it**, so the message stays
   *     in the mailbox and the next pass takes it in. Accepting it instead would create a ticket with no
   *     envelope — one an agent can read and **cannot answer**, with nothing on screen saying why.
   *
   * That is the same fail-closed discipline `person-members.client.ts` records ("an unavailable source
   * and a genuine nothing are indistinguishable unless one of them is an error"), and it does not
   * contradict FR-023: a resolution that *ran* never blocks anything. A transport that never ran is not
   * a resolution.
   */
  async resolve(input: {
    accountId: string;
    brandId: string;
    channelKind: string;
    /** The identifier CLASS, stated separately from the value (ADR 0044 §4). */
    kind: 'email' | 'phone' | 'player_id';
    value: string;
  }): Promise<ResolvedParticipant> {
    const md = new Metadata();
    md.set('x-actor-kind', 'system');

    let res: ParticipantWire;
    try {
      res = await firstValueFrom(
        this.machine.resolveChannelParticipant(
          {
            accountId: input.accountId,
            brandId: input.brandId,
            channelKind: input.channelKind,
            kind: input.kind,
            value: input.value,
          },
          md,
        ),
      );
    } catch (err) {
      // ⚠️ The error's NAME only. A gRPC error's message can quote the request, and the request carries
      // the customer's address (Principle IV, FR-047). Never the value, never the target host.
      throw new IdentitySourceUnavailableError(err instanceof Error ? err.name : 'rpc failed');
    }

    if (!res || typeof res.participantId !== 'string') {
      throw new IdentitySourceUnavailableError('unreadable response');
    }
    /**
     * ⚠️ **An empty handle is unreadable for an ADDRESS and expected for a platform id.**
     *
     * Asking about an address and getting no handle back means the reply path has no envelope — a ticket
     * an agent can read and cannot answer — so it is refused for the same reason as an unreachable
     * service. Asking about a `player_id` is different: there is nothing to answer to (the API channel
     * cannot carry an outbound message at all), so `users` deliberately writes no row.
     *
     * Decided from what THIS client asked rather than from a flag in the response: the caller knows which
     * question it put, and a response-driven check would have to trust the far side to be consistent.
     */
    if (res.participantId === '' && input.kind !== 'player_id') {
      throw new IdentitySourceUnavailableError('unreadable response');
    }

    return {
      participantId: res.participantId,
      // proto3 omits an empty string, so an absent `playerId` genuinely means unidentified.
      playerId: typeof res.playerId === 'string' ? res.playerId : '',
      ambiguous: res.ambiguous === true,
    };
  }
}

/**
 * Its own client provider, like `ChatsPersonModule` and for the same stated reason: the uploads channel
 * raises its message-size ceiling for attachment bytes, and this call carries one address and three ids.
 * Sharing a channel would tie an identity write's limits to whatever the byte path needs next.
 *
 * No new configuration — `USERS_GRPC_TARGET` is already a refuse-to-start requirement.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CHATS_PARTICIPANT_CLIENT,
        useFactory: () =>
          grpcClientOptions(USERS_PACKAGE, USERS_PROTO, process.env.USERS_GRPC_TARGET as string),
      },
    ]),
  ],
  providers: [ChannelParticipantClient],
  exports: [ChannelParticipantClient],
})
export class ChatsChannelParticipantModule {}
