/**
 * The closed channel-KIND catalogue (feature 033, roadmap 6.1/6.4/6.6 — subpoint 2.1e).
 *
 * ── Why this exists before anything writes a channel ────────────────────────────────────────────
 * `Conversation.channel` shipped as a nullable free-text string, and the values in the database today
 * are `'chat'`, `'email'`, `'api'` and NULL. Three subsystems are about to stand on that column — the
 * SLA policy per channel (ADR 0041), the Inbox filter (W6), the analytics split (W20) — and a second
 * *writer* of a free-text dimension is how they end up disagreeing about how "email" is spelled. So
 * the vocabulary is typed with the first real writer, not after it.
 *
 * ⚠️ **NO CODE BRANCHES ON A CHANNEL NAME OR KEY**, only on a kind. A *channel* is per-account
 * configuration — a row with a key, an address and a brand — exactly as a *status* is; a **kind** is
 * the closed set the machine understands. `tests/channels/no-channel-name-branch.spec.ts` asserts it
 * as a scan rather than trusting it as a style preference, the way feature 032 did for status keys and
 * feature 016 for upload purposes.
 *
 * ── The column stays nullable, and that is not laziness ─────────────────────────────────────────
 * About one in six conversations carries no channel at all: a ticket an agent raised, or a seeded one.
 * That is an **absence**, not a fourth kind, and `conversation.repository.ts` already warns that a
 * `channel: null` predicate must never be introduced because those rows stay reachable precisely by
 * the filter being undefined. Inventing an `internal` kind to fill a legitimate absence would be a
 * lie in the data and would break the 029 filter contract.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────────────────────────
 * The capability answers (may we initiate, is there a reply window, attachments, templates). They live
 * in `capabilities.ts`, because a *kind* is an identity and a *capability* is a claim about a platform
 * that changes without the vocabulary changing.
 *
 * Pure data + pure helpers. No I/O.
 */

/** The three kinds. Closed and additive; adding one is a deliberate edit here. */
export const CHANNEL_KINDS = ['api', 'email', 'messenger'] as const;

export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface ChannelKindSpec {
  /** One line a reader of the catalogue, not of the code, can understand. */
  label: string;
  /**
   * Whether the product can actually carry a message on this kind today.
   *
   * `messenger` is **false**: the kind and the adapter contract ship in this feature so that the Inbox
   * filter, the analytics split and every future channel have something to stand on, while the live
   * transport waits on the vendor question (`O1`, `reference/novatalk-channel-initiation.md`). A send
   * attempt is refused as unavailable — never a crash, never a silent no-op.
   */
  liveTransport: boolean;
  /** The proto enum value. Explicit, never derived by string munging — `wire.ts`'s precedent. */
  wire: string;
}

export const CHANNEL_KIND_SPECS: Readonly<Record<ChannelKind, ChannelKindSpec>> = {
  api: {
    // The operator's own LLM widget posts here. "API" rather than "chat" because the shape is a
    // signed webhook from a system we do not control, not a conversation transport of ours.
    label: 'Signed webhook from the platform widget',
    liveTransport: true,
    wire: 'CHANNEL_KIND_API',
  },
  email: {
    label: 'The brand support mailbox',
    liveTransport: true,
    wire: 'CHANNEL_KIND_EMAIL',
  },
  messenger: {
    label: 'Messenger platforms (contract only in the MVP)',
    liveTransport: false,
    wire: 'CHANNEL_KIND_MESSENGER',
  },
};

export const isChannelKind = (value: unknown): value is ChannelKind =>
  typeof value === 'string' && (CHANNEL_KINDS as readonly string[]).includes(value);

/**
 * The kinds a message can actually be sent on today. Read by the outbound path's capability gate.
 *
 * Derived from the specs rather than listed again: two lists of the same fact drift, and the one that
 * drifts is always the one nobody is looking at.
 */
export const LIVE_CHANNEL_KINDS: readonly ChannelKind[] = CHANNEL_KINDS.filter(
  (k) => CHANNEL_KIND_SPECS[k].liveTransport,
);

/**
 * Map a stored value to a kind.
 *
 * `undefined` means **no arrival channel**, which is a real and common answer (see the header). `null`
 * means a value the vocabulary does not define — a migration that missed a row, or a hand-written
 * INSERT. The two are separated on purpose: a caller that treats "no channel" and "a word we do not
 * recognise" the same way cannot report the second one, and the second one is a defect.
 */
export function channelKindFromStored(value: string | null | undefined): ChannelKind | undefined | null {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  return isChannelKind(value) ? value : null;
}

/** `undefined` = no kind asked for (absent or UNSPECIFIED). `null` = a value the wire does not define. */
export function channelKindFromWire(wire: string | undefined): ChannelKind | undefined | null {
  if (!wire || wire === 'CHANNEL_KIND_UNSPECIFIED') return undefined;
  const found = CHANNEL_KINDS.find((k) => CHANNEL_KIND_SPECS[k].wire === wire);
  return found ?? null;
}

/** A stored kind → its proto value. An unknown value yields UNSPECIFIED, never a guess. */
export function channelKindToWire(kind: string | null | undefined): string {
  return isChannelKind(kind) ? CHANNEL_KIND_SPECS[kind].wire : 'CHANNEL_KIND_UNSPECIFIED';
}
