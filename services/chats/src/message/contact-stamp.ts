/**
 * Which contact stamp a message sets (feature 022, roadmap 4.13). Pure — no database, no clock.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────────────────────────
 * The player card must say when we last talked to a customer. The value that *looks* like that
 * already — `Conversation.updated_at` — is a Prisma `@updatedAt` column, so relabelling, reassigning
 * or resolving a conversation bumps it. A card built on it reports our own internal work as customer
 * contact, and looks entirely right doing so. So the fact is derived from MESSAGES and maintained on
 * two columns (`last_inbound_at`, `last_outbound_at`) written in the message's own transaction
 * (research R1/R2).
 *
 * ── The rule, and why it is not restated anywhere else ───────────────────────────────────────────
 *   player   + any            → last_inbound_at   (a customer wrote to us)
 *   operator + public reply   → last_outbound_at  (we answered them)
 *   operator + private note   → NOTHING           — staff writing to staff is not contact (SEC-13)
 *   system   + any            → NOTHING           — machine output is not a conversation
 *
 * "A private note is inert" is the SAME fact the first-reply SLA clock encodes (`sla/first-reply.ts`,
 * roadmap 4.7 / FR-012 there). One fact, one definition: two definitions of "we replied" would drift,
 * and the drift would be invisible until a card and an SLA report disagreed about the same
 * conversation.
 *
 * Fail-closed on an author type this rule does not know: `null`, never a guessed column. An unknown
 * author appearing on a card as customer contact is worse than not appearing at all.
 */

/** The only columns this rule can select. Every read in the feature aggregates exactly these two. */
export const CONTACT_STAMP_COLUMNS = ['last_inbound_at', 'last_outbound_at'] as const;

export type ContactStampColumn = (typeof CONTACT_STAMP_COLUMNS)[number];

/**
 * @param authorType `Message.author_type` — 'player' | 'operator' | 'system' (free-form column).
 * @param isPrivate  `Message.private` — an internal note.
 * @returns the column to stamp, or `null` when this message is not contact with the customer.
 */
export function decideContactStamp(
  authorType: string,
  isPrivate: boolean,
): ContactStampColumn | null {
  // A customer cannot write an internal note. Not reachable today (`RecordIncomingMessage` hard-codes
  // `isPrivate: false`), and refused here rather than assumed: a private inbound row is excluded from
  // the customer projection, so counting it as "they wrote to us" would put an invisible message on
  // the card as visible contact.
  if (authorType === 'player') return isPrivate ? null : 'last_inbound_at';
  if (authorType === 'operator') return isPrivate ? null : 'last_outbound_at';
  return null;
}
