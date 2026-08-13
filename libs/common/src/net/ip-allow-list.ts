/**
 * A FAIL-CLOSED address allow-list (feature 038, ADR 0043 §5 — SEC-PV1).
 *
 * ── ⚠️ The default is the opposite of `mail/guards.ts`, and that is deliberate ───────────────────
 * The outbound mail guard treats an EMPTY list as «no restriction», because its list narrows an
 * egress that is otherwise legitimate: an operator who configures nothing still expects mail to
 * leave. This list guards an INBOUND credential that can mint and disable staff accounts, so an
 * empty list must mean «nobody», never «anybody» — a key whose addresses were never configured is a
 * key nobody decided to trust, and the safe reading of an absent decision is refusal.
 *
 * Both directions are correct for their own boundary; what would be wrong is one helper serving both
 * and someone later «fixing» the inconsistency. Hence two helpers, each stating the other exists.
 *
 * ── What it does NOT do ─────────────────────────────────────────────────────────────────────────
 * No CIDR, no ranges, no wildcards. One consumer, a handful of static addresses, and a range syntax
 * is a parser that has to be right about netmasks before anyone notices it is wrong. Exact matches
 * only; the day a range is genuinely needed it arrives with its own tests.
 *
 * Pure functions, no I/O.
 */

/** Normalise one address for comparison: trim, lower-case, unwrap an IPv6-mapped IPv4. */
function normalise(address: string): string {
  const trimmed = address.trim().toLowerCase();
  // `::ffff:203.0.113.7` is how a v4 client appears through a v6 socket — the same machine, and a
  // reader who typed the v4 form into the allow-list means it.
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/** Parse a stored/configured list. Blank entries vanish; nothing is invented. */
export function parseIpAllowList(raw: readonly string[] | string | undefined | null): string[] {
  const parts = typeof raw === 'string' ? raw.split(',') : (raw ?? []);
  return [...new Set(parts.map(normalise).filter((v) => v !== ''))];
}

/**
 * Is this caller allowed?
 *
 * ⚠️ An EMPTY list denies. An absent/blank address denies too: «we could not tell who called» is not
 * a reason to proceed on a surface that creates accounts.
 */
export function isAddressAllowed(
  address: string | undefined | null,
  allowList: readonly string[],
): boolean {
  if (allowList.length === 0) return false;
  const candidate = normalise(address ?? '');
  if (candidate === '') return false;
  return parseIpAllowList(allowList).includes(candidate);
}

/**
 * The caller's address as seen through our own edge.
 *
 * ⚠️ `x-forwarded-for` is a CHAIN and only the entry our own proxy appended can be trusted — the
 * left-hand entries are whatever the client claimed. Caddy (both stands) appends the real peer last,
 * so the LAST element is the one to read; a client-supplied header therefore cannot spoof its way
 * into an allow-list. If this product is ever put behind a proxy that prepends instead, this is the
 * one function to change, and it is the reason the extraction is not inlined at the call site.
 */
export function clientAddressFrom(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
): string {
  const chain = (forwardedFor ?? '')
    .split(',')
    .map(normalise)
    .filter((v) => v !== '');
  return chain.length > 0 ? chain[chain.length - 1]! : normalise(socketAddress ?? '');
}
