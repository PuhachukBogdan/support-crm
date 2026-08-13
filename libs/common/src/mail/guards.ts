/**
 * The two egress guards every mail connection in the product passes (Principle III).
 *
 * Both are checked **before the socket opens**, and that ordering is the requirement rather than an
 * optimisation: the connection *is* the harm. A synthetic stand that reaches a real relay has already
 * done the damage by the time the send succeeds, and a stand that opens an IMAP session against a real
 * mailbox has already authenticated against it.
 *
 * ── Why both read "empty = unrestricted" ────────────────────────────────────────────────────────
 * Reversed, an empty list would silently stop all mail in production, where empty is the legitimate
 * configuration — and mail that has stopped looks exactly like mail that is merely slow. Feature 028
 * made this choice for recipients and defended it; feature 033 keeps it for hosts so the two cannot
 * disagree.
 *
 * ⚠️ The **opposite** default governs channel secrets (`CHANNEL_SECRETS`), where absent means *nothing
 * can be verified so nothing is accepted*. That is not an inconsistency: unrestricted egress is a real
 * production setting, whereas an unverifiable webhook never is.
 */

/**
 * Parse the recipient allow-list (028 FR-018/FR-019).
 *
 * A leading `@` is accepted because that is how somebody writing down a domain will type it.
 */
export function parseAllowedRecipientDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
}

/** ⚠️ Empty list = unrestricted. See the header. */
export function isRecipientAllowed(to: string, allowedDomains: readonly string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = to.split('@').pop()?.trim().toLowerCase() ?? '';
  return allowedDomains.includes(domain);
}

/**
 * Parse the outbound host allow-list (feature 033, FR-041/FR-048).
 *
 * Case-folded because host names are case-insensitive, and a port is stripped if somebody writes one:
 * the guard compares HOSTS, so `greenmail:3143` failing to match `greenmail` would be a refusal nobody
 * could explain from the value they typed. That is a usability property with a security failure mode —
 * the natural response to "mail stopped and the list looks right" is to empty the list, which turns the
 * guard off altogether.
 */
export function parseHostAllowList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter((h) => h.length > 0);
}

/** ⚠️ Empty list = unrestricted. See the header. */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.includes(host.trim().toLowerCase().replace(/:\d+$/, ''));
}
