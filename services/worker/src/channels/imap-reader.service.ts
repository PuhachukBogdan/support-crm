import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { isHostAllowed } from '@crm/common';
import { RedisService } from '../queue/redis.service';
import { ChatsMaintenanceClient } from '../chats/chats.client';
import { UsersUploadsClient } from '../users/users.client';
import { loadWorkerConfig, type WorkerConfig } from '../config';
import { parseInboundEmail } from './email.adapter';

/**
 * The mailbox connection (feature 033, roadmap 6.4 — T045/T080, FR-027, research R2/R8).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THE MAILBOX TELLS US, WE DO NOT ASK.** The operator asked for this by name — *«я бы хотел чтоб
 * оно в real time собирало их»* — so the transport is `IMAP IDLE`: an open connection the server pushes
 * to. A message becomes a ticket within seconds of arriving rather than within a polling interval.
 *
 * `channels/mail-sweep-inbound.job.ts` is the **safety net** for a dropped connection, a process that
 * died mid-batch, or a message that landed during a restart. It is not the delivery path, and if its
 * interval ever starts to matter for how fast mail appears, this file is broken and the sweep is hiding
 * it — the same division feature 028 recorded for outbound identity mail.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ⚠️ THE LEASE IS AN EFFICIENCY DEVICE, NOT THE CORRECTNESS DEVICE ────────────────────────────
 * Exactly one replica should hold the connection, so a Redis lease (`SET NX PX`, renewed on a timer)
 * decides which. **Correctness does not depend on it.** At-most-once is `@@unique([account_id,
 * external_id])` on the message row (FR-032): if two replicas ever race — a lock expiring under a long
 * GC pause is the ordinary way — the second insert loses and the customer's message still appears once.
 *
 * Stating this is not pedantry. The opposite design ("the lease guarantees single delivery") is exactly
 * how a lock expiry becomes a duplicated customer message, and it fails in production and never in a test.
 *
 * A BullMQ *repeatable job* would not have worked here: it fires once across replicas, which is right for
 * a tick and meaningless for a **persistent connection** — every replica would open its own IDLE and every
 * replica would be told about every message.
 *
 * ── ⚠️ THE EGRESS GUARD RUNS BEFORE ANY SOCKET IS OPENED ────────────────────────────────────────
 * `MAIL_ALLOWED_HOSTS` is checked in {@link start} before `ImapFlow` is constructed (Principle III,
 * FR-048). **The harm is the connection**, so a check that ran after connecting would prove nothing —
 * which is precisely what `imap-egress.spec.ts` asserts, by counting constructions rather than errors.
 */
@Injectable()
export class ImapReaderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImapReaderService.name);
  private readonly cfg: WorkerConfig = loadWorkerConfig();
  private client?: ImapFlow;
  private renewTimer?: NodeJS.Timeout;
  private stopping = false;
  /** Resolved once from chats and held: the mailbox↔channel binding is configuration, not runtime state. */
  private tenant?: { accountId: string; brandId: string };

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
    @Inject(UsersUploadsClient) private readonly uploads: UsersUploadsClient,
  ) {}

  /** How long a lease lives, and how often it is renewed. Renewal at a third of the TTL. */
  private static readonly LEASE_TTL_MS = 30_000;
  private static readonly LEASE_KEY = 'crm:channel:imap:lease';

  async onModuleInit(): Promise<void> {
    // Absent host ⇒ no email channel in this deployment, including the whole test suite. Not an error,
    // and deliberately not a refuse-to-start key: a mailbox is legitimately absent, unlike chats.
    if (this.cfg.CHANNEL_IMAP.host === '' || this.cfg.CHANNEL_KEY === '') {
      this.logger.log('mailbox reader idle: no channel mailbox configured');
      return;
    }
    // Not awaited: a mailbox that is slow to answer must not delay the process coming up, and every
    // failure inside is a retry rather than a crash.
    void this.run();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    await this.close();
    // Give the lease back so another replica takes over in seconds rather than after the TTL.
    await this.redis.client.del(ImapReaderService.LEASE_KEY).catch(() => undefined);
  }

  /**
   * Acquire the lease, hold the connection, and reconnect for as long as this process lives.
   *
   * ⚠️ Every error is a delay, never a crash. A mailbox that is down must not take the worker with it —
   * the SLA sweep, the export queue and the purge all live in this process.
   */
  private async run(): Promise<void> {
    let backoffMs = 1_000;
    while (!this.stopping) {
      try {
        if (await this.acquireLease()) {
          await this.start();
          backoffMs = 1_000;
        }
      } catch (err) {
        // ⚠️ The error's NAME only. An IMAP error message can quote the mailbox, the credentials it
        // tried, or a message header — all of which are Principle IV material.
        this.logger.warn(`mailbox reader: ${err instanceof Error ? err.name : 'error'}`);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
      await this.close();
      if (this.stopping) return;
      await sleep(backoffMs);
    }
  }

  /** `SET NX PX` — the lease. Renewed while held; a replica that loses it closes its connection. */
  private async acquireLease(): Promise<boolean> {
    // Per-process, so a renewal can never extend another replica's lease. Only used for the `XX`
    // renewal; releasing on shutdown deletes unconditionally, which is safe because a replica only
    // reaches shutdown holding its own.
    const token = `${process.pid}:${randomUUID()}`;
    const ok = await this.redis.client.set(
      ImapReaderService.LEASE_KEY,
      token,
      'PX',
      ImapReaderService.LEASE_TTL_MS,
      'NX',
    );
    if (ok !== 'OK') return false;

    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = setInterval(() => {
      // Renewed unconditionally rather than compare-and-swap: losing the lease is survivable (see the
      // header — the unique constraint is the correctness device), and a failed renewal simply lets it
      // expire, at which point another replica takes over.
      void this.redis.client
        .set(ImapReaderService.LEASE_KEY, token, 'PX', ImapReaderService.LEASE_TTL_MS, 'XX')
        .catch(() => undefined);
    }, Math.floor(ImapReaderService.LEASE_TTL_MS / 3));
    return true;
  }

  /**
   * Open the connection and hold it, taking in whatever is unread and whatever arrives.
   *
   * Returns when the connection drops, so {@link run} reconnects.
   */
  private async start(): Promise<void> {
    const imap = this.cfg.CHANNEL_IMAP;

    // ⭐ BEFORE THE SOCKET. See the header: the harm is the connection, so the guard cannot run after it.
    if (!isHostAllowed(imap.host, this.cfg.MAIL_ALLOWED_HOSTS)) {
      // The host is configuration written by an operator, not customer data, so naming it is what makes
      // this line actionable — the whole failure mode this guard has is "mail stopped and nothing said why".
      this.logger.error(`mailbox host not in MAIL_ALLOWED_HOSTS: ${imap.host} — refusing to connect`);
      // Not a retryable condition: retrying a configuration error every second would produce a hot loop
      // against a host we already decided not to reach.
      this.stopping = true;
      return;
    }

    await this.resolveTenant();
    if (!this.tenant) return;

    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.password },
      // The library's own logging would print message headers and the authentication exchange.
      logger: false,
    });
    this.client = client;

    await client.connect();
    await client.mailboxOpen('INBOX');
    this.logger.log(`mailbox reader connected host=${imap.host} — IDLE`);

    // Whatever arrived while nobody was connected. ⚠️ This is not a catch-up mechanism we depend on: it
    // is the same take-in as the push below, and at-most-once makes running it twice harmless.
    await this.takeInUnseen(client);

    client.on('exists', () => {
      // Serialised through a promise chain rather than run concurrently: two overlapping batches would
      // both fetch the same unseen set, and while the constraint makes that safe it is pure waste.
      void this.takeInUnseen(client).catch((err) => {
        this.logger.warn(`mailbox batch failed: ${err instanceof Error ? err.name : 'error'}`);
      });
    });

    // Resolves when the connection closes — the signal `run` waits on.
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => resolve());
    });
  }

  /** Which tenant owns our channel key. Asked once, from the authority (never from configuration). */
  private async resolveTenant(): Promise<void> {
    if (this.tenant) return;
    const resolved = await this.chats.resolveIntakeChannel(this.cfg.CHANNEL_KEY);
    if (!resolved.accountId) {
      // Unknown or disabled — deliberately indistinguishable (FR-008). Disabling a channel is the
      // operator's stop button until the admin screen exists, and it must actually stop this reader.
      this.logger.warn(`channel key not configured for intake: reader staying shut`);
      this.stopping = true;
      return;
    }
    if (resolved.kind !== 'email') {
      // Chats refuses this too, per-message. Refused here as well so a misconfiguration is one log line
      // at startup rather than one per message for ever.
      this.logger.error(`channel key names a '${resolved.kind}' channel, not email — refusing to read`);
      this.stopping = true;
      return;
    }
    this.tenant = { accountId: resolved.accountId, brandId: resolved.brandId };
  }

  /**
   * Take in every unseen message, one at a time.
   *
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   * ⚠️ **ONE POISONOUS MESSAGE MAY NEVER STOP THE INTAKE** (FR-034). Every message is handled inside
   * its own `try`, so an unparseable one is refused, counted and left behind while the next is taken in.
   * Feature 031 shipped the opposite — one bad row killed the whole tick — and it was found on a live
   * run rather than by a test, which is why this is a loop with a `try` inside rather than around.
   * ═══════════════════════════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ **`\Seen` is set only AFTER chats has answered.** A message marked seen before the write would be
   * invisible to the sweep, so a crash in between would lose it silently — and "silently" is the whole
   * problem: the customer is waiting and nothing in the product knows.
   */
  async takeInUnseen(client: ImapFlow): Promise<{ taken: number; refused: number }> {
    const tenant = this.tenant;
    if (!tenant) return { taken: 0, refused: 0 };

    let taken = 0;
    let refused = 0;

    for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
      if (this.stopping) break;
      try {
        const parsed = await parseInboundEmail(msg.source as Buffer, this.ourAddresses());
        if (!parsed.ok) {
          refused++;
          // The CLASS and the uid. Never a header, never the sender, never the body.
          this.logger.warn(`mail refused class=${parsed.refusal} uid=${msg.uid}`);
          // ⚠️ Marked seen anyway. A message we will never accept must not be re-read for ever — an
          // auto-reply loop would otherwise be refused once per reconnect, at machine speed, for the
          // lifetime of the mailbox. The ledger row in chats is the record that it arrived.
          await this.markSeen(client, msg.uid);
          continue;
        }

        const uploadIds = await this.storeAttachments(tenant.accountId, parsed.message.attachments);

        const outcome = await this.chats.acceptInboundEmail({
          channelKey: this.cfg.CHANNEL_KEY,
          messageId: parsed.message.messageId,
          inReplyTo: parsed.message.inReplyTo,
          references: parsed.message.references,
          fromAddress: parsed.message.fromAddress,
          subject: parsed.message.subject,
          bodyText: parsed.message.bodyText,
          uploadIds,
          sentAt: parsed.message.sentAt ? Math.floor(parsed.message.sentAt.getTime() / 1000) : undefined,
        });

        if (outcome.refusalClass) {
          refused++;
          this.logger.warn(`mail refused class=${outcome.refusalClass} uid=${msg.uid}`);
          // ⚠️ NOT marked seen. Unlike a parse refusal, chats' refusals include the retryable ones —
          // `identity_unavailable` above all — and leaving the message unread is what lets the next pass
          // succeed once the dependency is back.
          continue;
        }

        taken++;
        await this.markSeen(client, msg.uid);
      } catch (err) {
        refused++;
        this.logger.warn(
          `mail batch item failed uid=${msg.uid}: ${err instanceof Error ? err.name : 'error'}`,
        );
        // Left unread on purpose: an exception is not a verdict, and the next pass tries again.
      }
    }

    if (taken > 0 || refused > 0) this.logger.log(`mail intake: taken=${taken} refused=${refused}`);
    return { taken, refused };
  }

  /**
   * Store the files, keeping the message's own order.
   *
   * ⚠️ A file `users` refuses is COUNTED and dropped; the message still lands (FR-018). Losing the
   * customer's words to a bad screenshot is indistinguishable from the product working.
   */
  private async storeAttachments(
    accountId: string,
    files: Array<{ filename: string; declaredContentType: string; content: Buffer }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    let dropped = 0;
    for (const file of files) {
      const id = await this.uploads.storeInbound(accountId, file);
      if (id) ids.push(id);
      else dropped++;
    }
    // A COUNT, never a filename — a filename can itself be PII (feature 016's FR-020).
    if (dropped > 0) this.logger.warn(`mail attachments refused count=${dropped}`);
    return ids;
  }

  /** Our own sending addresses, for the loop check no header provides (research R14). */
  private ourAddresses(): string[] {
    const own = [this.cfg.CHANNEL_IMAP.user, this.cfg.CHANNEL_MAIL_FROM]
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a !== '');
    return [...new Set(own)];
  }

  /**
   * Sweep the LIVE connection — the safety net's only entry point (`mail-sweep-inbound.job.ts`).
   *
   * ⚠️ Returns `null` rather than opening a connection when there is none. A sweep that dialled the
   * mailbox itself would be a second IMAP session per replica — the multiplication the lease exists to
   * prevent — and would need its own copy of the credentials and its own egress guard.
   */
  async sweepUnseen(): Promise<{ taken: number; refused: number } | null> {
    const client = this.client;
    if (!client || !client.usable) return null;
    return this.takeInUnseen(client);
  }

  private async markSeen(client: ImapFlow, uid: number): Promise<void> {
    // Failure here is survivable: the message is re-read next pass and the unique constraint refuses the
    // duplicate. Throwing would abandon a batch over a flag.
    await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true }).catch(() => false);
  }

  private async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    await client.logout().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
