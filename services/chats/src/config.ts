import { loadConfig, z } from '@crm/common';

/**
 * Required config for the chats service (spec 003, US2). Validated at boot — the service
 * refuses to start on any missing/placeholder value (SEC-6).
 *
 * `AUTH_GRPC_TARGET` (feature 014): an automation rule acts with its author's CURRENT permissions,
 * resolved from auth on every evaluation (FR-023). Without that dial target every rule would refuse
 * (fail-closed, FR-024) — which is safe but useless, so it is a boot requirement rather than a
 * runtime surprise.
 *
 * `USERS_GRPC_TARGET` (feature 016): attachments are claimed and described over the users contract
 * (research R8). Same reasoning — a chats service that cannot reach users would refuse every message
 * carrying a file, which is safe and useless. Adding a cross-service client to chats is therefore
 * always a TWO-FILE change: this guard and the matching entry in `compose.yaml`.
 *
 * ── Feature 023 (roadmap 4.8a / 4.18) — the four keys below are OPTIONAL WITH DEFAULTS, and that is
 *    a different category from everything above. ─────────────────────────────────────────────────
 *
 * The keys above are refuse-to-start because a wrong value there is a silent security or availability
 * failure. These four are tuning values with safe defaults: a missing one must not stop the service.
 *
 * 🅿 THE TWO RETENTION VALUES ARE PROVISIONAL. They were set by us, not by the operator, because he
 * was unavailable and did not want the project to stall. They are **revised by** his answer on how
 * long access records are kept (open question Q1) and by SEC-25. They are configuration precisely so
 * that answering is a value change, not a code change.
 *
 * ⚠️ AND NOTHING READS THEM YET, DELIBERATELY. No cleanup job is built: deleting history on a number
 * nobody has confirmed is exactly what feature 018 refused when it implemented `record.open` and then
 * REVERTED it, because feature 015 had attached the precondition "best-effort recording ships WITH a
 * retention policy". Declaring the window now means the later job reads a value instead of inventing
 * one. `transition/retention.spec.ts` asserts no code deletes a transition today.
 */
export function loadChatsConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
      AUTH_GRPC_TARGET: z.string().min(1),
      USERS_GRPC_TARGET: z.string().min(1),

      // ── Feature 023 — see the header ──────────────────────────────────────────────────────────
      //
      // ⚠️ `.default()` DOES NOT APPLY HERE, and writing one would be a lie in a security-relevant
      // file. `loadConfig` checks presence BEFORE zod runs (the SEC-6 refuse-to-start gate), so every
      // key in this shape is required in the environment whatever its schema says. The first draft
      // carried `.default(365)` and friends; the live run refused to boot and was right to.
      //
      /** 🅿 provisional — revised by Q1 / SEC-25. Ordinary transitions. No job reads it yet (R9). */
      TRANSITION_RETENTION_DAYS: z.coerce.number().int().positive(),
      /** 🅿 provisional — revised by Q1 / SEC-25. The restricted contact-lookup class (no writer yet). */
      TRANSITION_RESTRICTED_RETENTION_DAYS: z.coerce.number().int().positive(),
      /**
       * The third window-closing arm (R10/U8), READ BY THE SWEEP. Deployment-scoped on purpose: a test
       * environment legitimately wants a shorter window, and exactly one thing reads it, so there is
       * nothing for it to disagree with.
       */
      SUBJECT_WINDOW_TIMEOUT_MINUTES: z.coerce.number().int().positive(),

      /**
       * ── Feature 024 (roadmap 5.3) — how many open conversations one operator may hold before
       * auto-assignment skips them, when the candidate pool is built from a GROUP.
       *
       * 🅿 **PROVISIONAL.** There is no authoritative source for capacity yet: presence (5.9) does not
       * exist — the WebSocket still serves a single `ping` handler — and ADR 0042's per-channel
       * capacity budgets are roadmap 4.19–4.21. **Revised by:** 4.19–4.21 (per channel, per role and
       * brand) and 5.9 (availability). The mark travels with the value into `compose.yaml`,
       * `.env.example` and the seed; a provisional decision is in force but must never be presented
       * as settled.
       *
       * It only ever applies to the group path. A caller supplying its own candidate list supplies
       * its own capacities, exactly as before — this value cannot change that behaviour.
       */
      ROUTING_DEFAULT_CAPACITY: z.coerce.number().int().positive(),

      // ⚠️ SUBJECT_MAX_LENGTH is deliberately NOT here — see the note at the foot of this file.
    },
    env,
  );
}

/**
 * ── Feature 033 (roadmap 6.1/6.5) — the channel intake's two configuration values ────────────────
 *
 * These are a THIRD category, distinct from both groups above, and the distinction is the point:
 * they are **tunables with safe defaults**, parsed after the refuse-to-start gate rather than through
 * it. `loadConfig` checks presence before zod runs, so a key routed through it is required in every
 * environment whatever its schema says — and requiring these would mean a deployment that runs no
 * channels at all cannot boot.
 *
 * The safety does not come from the default; it comes from which way the default fails. Absent
 * secrets ⇒ an empty map ⇒ **every delivery is refused** as an unknown channel. There is no value of
 * this configuration that makes an unverifiable webhook acceptable.
 */
export function loadChannelConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    /** channel key → shared secret. Empty map = nothing can be verified = nothing is accepted. */
    secrets: parseChannelSecrets(env.CHANNEL_SECRETS),
    /**
     * How far a delivery's timestamp may sit from ours.
     *
     * ⚠️ It bounds FORGERY, not duplication. A captured body must not stay replayable forever; a
     * *duplicate* is stopped by the unique constraint on `(channel_id, external_event_id)`, which is
     * why a replay arriving after this window is refused as stale rather than accepted as new. The two
     * mechanisms are often conflated, and conflating them yields a system that accepts a duplicate
     * once it is old enough.
     */
    replayWindowSeconds: clampInt(env.CHANNEL_INTAKE_REPLAY_WINDOW_S, 300, 5, 3_600),
    /** The single support mailbox of the MVP (2.1h). Used by the seed; empty is legitimate. */
    emailAddress: (env.CHANNEL_EMAIL_ADDRESS ?? '').trim(),
    /**
     * Attempts before a delivery is dead-lettered (FR-039).
     *
     * ⚠️ Bounded, and the bound matters in the unusual direction: an unbounded retry of a reply the relay
     * keeps refusing is not persistence, it is the product spending itself on a message that will never
     * arrive — while the agent believes the customer has been answered. A dead letter in `failed` is a
     * row a person can find; an infinite retry is a silence nobody investigates.
     */
    maxAttempts: clampInt(env.CHANNEL_MAIL_MAX_ATTEMPTS, 5, 1, 20),
  };
}

/**
 * Parse `key:secret,key:secret` into a lookup.
 *
 * ⚠️ **A malformed entry is DROPPED, never guessed at.** A pair with no colon, an empty key or an
 * empty secret would otherwise become a channel that verifies against `''` — which every unsigned
 * delivery satisfies. Dropping it means that channel is unknown and its deliveries are refused, which
 * is the same outcome as not configuring it at all.
 *
 * A secret is never logged, never returned in an error, and never compared with `===` (see
 * `channel/signature.ts` — the comparison is constant-time).
 */
export function parseChannelSecrets(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const colon = trimmed.indexOf(':');
    // A secret may itself contain ':' — split on the FIRST one only, or a base64 secret silently
    // truncates and every signature fails with nothing to see in a log.
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const secret = trimmed.slice(colon + 1).trim();
    if (key === '' || secret === '') continue;
    out.set(key, secret);
  }
  return out;
}

/** Parse an integer env value; fall back when unparseable, clamp into [min, max]. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type ChannelConfig = ReturnType<typeof loadChannelConfig>;

/** Nest DI token carrying the validated {@link ChannelConfig}. */
export const CHANNEL_CONFIG = Symbol('CHANNEL_CONFIG');

export type ChatsConfig = ReturnType<typeof loadChatsConfig>;

/**
 * ⚠️ Why the title cap is a CONSTANT and not configuration (corrected 2026-08-01, during the live run).
 *
 * `data-model.md` §6 listed four configuration values, and the first implementation declared all four.
 * Two problems surfaced the moment the container booted:
 *
 *   1. **Two of them were inert.** `subject.derive.ts` and `subject.sweep.ts` used their own constants;
 *      the config keys were declared, required at boot, and read by nothing — the "declared control
 *      that does nothing" class this project has paid for repeatedly. The window timeout is now read by
 *      the sweep, so it is live.
 *   2. **The cap is a CONTRACT, not a deployment knob.** The gateway bounds the same value at its edge
 *      and cannot read a service's environment. Making it per-environment means an edge that rejects
 *      titles the service would accept, silently, on one host and not another. A shared limit with two
 *      enforcement points must have exactly one source, and `wire.spec.ts` pins the two together.
 *
 * So the cap lives in `subject/subject.derive.ts` as `MAX_SUBJECT_LENGTH`, and §6 is amended.
 */
