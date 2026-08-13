import { loadConfig, parseHostAllowList, z } from '@crm/common';

/**
 * Required config for the worker service (spec 003, US2). Validated at boot — refuse to
 * start on missing/placeholder values (SEC-6). The worker owns no relational database; it
 * connects to Redis (via BullMQ) and exposes a gRPC health surface.
 *
 * Feature 014 gives it its first real job — the first-reply SLA sweep (roadmap 4.7). Its role there
 * is scheduling ONLY: fire a repeatable tick, call the chats maintenance RPC. It holds no rule state
 * and makes no decisions; chats owns the data and the verdict (research R1/R2).
 *
 * `CHATS_GRPC_TARGET` is therefore REQUIRED: a worker that cannot reach chats cannot sweep, and
 * failing loudly at boot beats a silently non-sweeping worker — nobody is waiting on a breach, so
 * nothing else in the system would ever notice.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      CHATS_GRPC_TARGET: z.string().min(1),
      // Feature 017 (roadmap 4.10): the worker also ticks the artefact purge, and `users` owns the
      // storage credentials and therefore the deletion. REQUIRED for the same reason as chats above:
      // a worker that cannot reach users cannot purge, and an export artefact that is never purged is
      // a PII copy outliving its authorization (SEC-27). Failing loudly at boot beats a silently
      // non-purging worker, because nobody is waiting on a deletion either.
      USERS_GRPC_TARGET: z.string().min(1),
      // Feature 028 — the mail sweep's target. Refuse-to-start like its siblings: a worker that
      // cannot reach auth silently stops retrying undelivered login codes, and nothing 500s.
      AUTH_GRPC_TARGET: z.string().min(1),
    },
    env,
  );

  return {
    ...required,
    // Tuning knobs, not secrets: absent ⇒ documented default; nonsense ⇒ clamped rather than a
    // refusal to boot. Detection latency is bounded by the interval by design (research R2), so a
    // 0 / negative / non-numeric value must never become a hot loop.
    SLA_SWEEP_INTERVAL_MS: clampInt(env.SLA_SWEEP_INTERVAL_MS, 30_000, 1_000, 3_600_000),
    SLA_SWEEP_BATCH: clampInt(env.SLA_SWEEP_BATCH, 500, 1, 5_000),
    // Feature 017. The export tick is the queue: a `queued` row waits at most one interval, which is
    // why 10 s (not 30) — an export is something a person is actively waiting for, unlike a breach.
    EXPORT_RUN_INTERVAL_MS: clampInt(env.EXPORT_RUN_INTERVAL_MS, 10_000, 1_000, 3_600_000),
    EXPORT_RUN_BATCH: clampInt(env.EXPORT_RUN_BATCH, 5, 1, 100),
    // The purge is not time-critical — an artefact one interval past its 24 h is not a new risk — so
    // this ticks slowly and in larger batches.
    ARTEFACT_PURGE_INTERVAL_MS: clampInt(env.ARTEFACT_PURGE_INTERVAL_MS, 300_000, 1_000, 3_600_000),
    ARTEFACT_PURGE_BATCH: clampInt(env.ARTEFACT_PURGE_BATCH, 100, 1, 1_000),

    // ── Feature 033 (roadmap 6.4) — the channel mailbox and the mail egress guard ─────────────────
    //
    // ⚠️ `CHANNEL_MAIL_SWEEP_INTERVAL_MS` is NOT the delivery latency, and that is the whole design.
    // Mail arrives because the mailbox TELLS us (IMAP IDLE, `channels/imap-reader.service.ts`); this
    // interval only governs the safety net for a dropped connection, a process that died mid-batch, or
    // a message that landed during a restart. The same division feature 028 recorded for outbound
    // identity mail. If this number ever starts to matter for how fast mail appears, the push path is
    // broken and the sweep is hiding it.
    CHANNEL_MAIL_SWEEP_INTERVAL_MS: clampInt(
      env.CHANNEL_MAIL_SWEEP_INTERVAL_MS,
      60_000,
      5_000,
      3_600_000,
    ),
    CHANNEL_MAIL_MAX_ATTEMPTS: clampInt(env.CHANNEL_MAIL_MAX_ATTEMPTS, 5, 1, 20),

    /**
     * The mailbox we are told about. Absent host ⇒ the reader does not start at all, which is the
     * right behaviour for every deployment that runs no email channel — including the whole test
     * suite. It is not a refuse-to-start key for that reason: an absent mailbox is a legitimate
     * configuration, unlike an unreachable chats service.
     */
    /**
     * Which channel this mailbox IS (`2.1h`). Empty ⇒ the reader stays shut, exactly as an absent host.
     *
     * ⚠️ Deliberately NOT accompanied by a `CHANNEL_ACCOUNT_ID`. The account and brand are resolved from
     * `chats` by this key (`ResolveIntakeChannel`), because a configured copy of what the `Channel` row
     * already states can DISAGREE with it — and the disagreement uploads one tenant's customer files into
     * another tenant's storage. Configuration may name which mailbox; only chats may say whose it is.
     */
    CHANNEL_KEY: (env.CHANNEL_KEY ?? '').trim(),

    /**
     * The address this channel sends FROM, when it differs from the IMAP user.
     *
     * Used for one thing only: recognising **our own mail coming back** (FR-033, research R14) — the loop
     * signal no header reliably provides. A reply arriving through a customer's auto-forward looks like a
     * customer message in every other respect.
     */
    CHANNEL_MAIL_FROM: (env.CHANNEL_MAIL_FROM ?? '').trim(),

    CHANNEL_IMAP: {
      host: (env.CHANNEL_IMAP_HOST ?? '').trim(),
      port: clampInt(env.CHANNEL_IMAP_PORT, 3143, 1, 65_535),
      secure: (env.CHANNEL_IMAP_SECURE ?? '').trim().toLowerCase() === 'true',
      user: (env.CHANNEL_IMAP_USER ?? '').trim(),
      password: env.CHANNEL_IMAP_PASSWORD ?? '',
    },

    /**
     * Host allow-list for every outbound mail connection the product opens — the IMAP mailbox this
     * service holds, and the SMTP relays in auth and chats (Principle III, FR-041/FR-048).
     *
     * ⚠️ **`MAIL_ALLOWED_HOSTS`, not `CHANNEL_MAIL_ALLOWED_HOSTS`.** One list for one boundary: a
     * channel-scoped name would have meant a second list the moment auth's relay needed the same
     * guard, and two allow-lists for one rule is the arrangement that ends with them disagreeing.
     * The parser is shared for the same reason — see `libs/common/src/mail/guards.ts`.
     *
     * ⚠️ **Empty means unrestricted**, the same reading feature 028 chose and defended for recipient
     * domains. Reversed, it would silently stop all mail in production, where an empty list is the
     * legitimate configuration, and mail that has stopped is indistinguishable from mail that is
     * merely slow. Set it on anything that is not production.
     */
    MAIL_ALLOWED_HOSTS: parseHostAllowList(env.MAIL_ALLOWED_HOSTS),
  };
}

/** Parse an integer env value; fall back when unparseable, clamp into [min, max]. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
