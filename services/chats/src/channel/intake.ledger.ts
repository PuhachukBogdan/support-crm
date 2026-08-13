import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Why a delivery was refused. A CLASS, and the vocabulary is closed.
 *
 * ⚠️ Nothing here is derived from the payload. A refusal reason built from a stranger's input is how a
 * log line becomes an injection surface and how a body ends up somewhere Principle IV forbids.
 */
export type IntakeRefusal =
  | 'signature'
  | 'unparseable'
  | 'loop'
  | 'no_event_id'
  | 'unknown_channel'
  | 'disabled'
  | 'no_status_configured'
  | 'replay_window'
  | 'incomplete';

export interface ClaimResult {
  /** False when this exact delivery has already been accepted — the caller answers success, not error. */
  fresh: boolean;
  /** The ledger row's id, for stamping what it produced. */
  intakeId: string;
  /** What the first acceptance produced, when this is a duplicate. */
  conversationId?: string;
  messageId?: string;
}

/**
 * The at-most-once ledger (feature 033, roadmap 6.1 — FR-012/FR-013).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **INSERT FIRST. NEVER SELECT-THEN-INSERT.**
 *
 * The claim is `create()` against `@@unique([channel_id, external_event_id])`, and a `P2002` violation is
 * read as *"already accepted"*. A `findFirst` followed by a `create` is a race — and not a theoretical
 * one: the provider's retry arrives **concurrently by design**, because that is what every webhook
 * provider does when its acknowledgement is lost. Two requests would both see nothing, both insert, and
 * the customer would have two tickets nobody can tell apart afterwards.
 *
 * This project has paid for that lesson twice: feature 014's attachment link and feature 031's assignment
 * budget were both check-then-write, and both were found on a live run rather than by a test.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class IntakeLedger {
  private readonly logger = new Logger(IntakeLedger.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Claim this delivery, or report that it was already accepted.
   *
   * Called BEFORE any conversation or message is written, so a duplicate costs one failed insert rather
   * than a partially-created ticket that has to be unwound.
   */
  async claim(input: {
    accountId: string;
    channelId: string;
    externalEventId: string;
  }): Promise<ClaimResult> {
    try {
      const row = (await this.prisma.forAccount(input.accountId).channelIntake.create({
        data: {
          account_id: input.accountId,
          channel_id: input.channelId,
          external_event_id: input.externalEventId,
          outcome: 'accepted',
        },
        select: { id: true },
      })) as { id: string };
      return { fresh: true, intakeId: row.id };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The duplicate path. Read what the FIRST acceptance produced so the caller can answer with the
      // same ids — a provider that retries deserves the same answer, not a different one.
      const existing = (await this.prisma.forAccount(input.accountId).channelIntake.findFirst({
        where: { channel_id: input.channelId, external_event_id: input.externalEventId },
        select: { id: true, conversation_id: true, message_id: true },
      })) as { id: string; conversation_id: string | null; message_id: string | null } | null;

      return {
        fresh: false,
        intakeId: existing?.id ?? '',
        conversationId: existing?.conversation_id ?? undefined,
        messageId: existing?.message_id ?? undefined,
      };
    }
  }

  /** Record what an accepted delivery produced. */
  async stampProduced(
    accountId: string,
    intakeId: string,
    produced: { conversationId: string; messageId: string },
  ): Promise<void> {
    await this.prisma.forAccount(accountId).channelIntake.updateMany({
      where: { id: intakeId },
      data: { conversation_id: produced.conversationId, message_id: produced.messageId },
    });
  }

  /**
   * Record a refusal.
   *
   * ── Why a refused delivery is a row at all ──────────────────────────────────────────────────────
   * FR-010 says a refusal leaves **no product data** — no conversation, no message, no upload. A ledger
   * row is not product data: it is the audit of a rejection and it carries no payload. Without it a
   * refusal is indistinguishable from a delivery that never arrived, and those have opposite causes —
   * one is our rejection, the other is somebody else's outage. Somebody will ask which, at 2am.
   *
   * ⚠️ **Never throws.** A failure to record a refusal must not turn a clean rejection into a 500: the
   * delivery is being refused either way, and the caller has nowhere to put a second error.
   */
  async recordRefusal(input: {
    accountId: string;
    channelId: string;
    externalEventId: string;
    refusal: IntakeRefusal;
  }): Promise<void> {
    try {
      await this.prisma.forAccount(input.accountId).channelIntake.create({
        data: {
          account_id: input.accountId,
          channel_id: input.channelId,
          // A refusal may have no derivable event id — that is one of the refusal reasons. The row still
          // has to exist, so the id is synthesised for the ledger's own uniqueness and is never treated
          // as a delivery identifier: `refused:<class>:<uuid>` can never collide with a provider's id.
          external_event_id: input.externalEventId || `refused:${input.refusal}:${crypto.randomUUID()}`,
          outcome: 'refused',
          refusal_class: input.refusal,
        },
      });
    } catch {
      // The class and nothing else. No payload, no signature, no secret.
      this.logger.warn(`intake refusal not recorded class=${input.refusal}`);
    }
  }
}

/** Prisma's unique-constraint error. Matched on the code, not on the message text. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}
