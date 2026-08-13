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

/**
 * Normalise one address for comparison: trim, lower-case, unwrap an IPv6-mapped IPv4.
 *
 * ⚠️ EXPORTED since W32, because a second writer needed it and reaching it through
 * `parseIpAllowList([raw])[0]` — which is what the deny-list first had to do — is the shape that
 * eventually becomes somebody's own hand-rolled copy. **Whoever STORES an address must normalise it
 * with the same function the boundary COMPARES with**, or a ban is saved in a form nothing matches:
 * present on the screen, stopping nobody.
 */
export function normalise(address: string): string {
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
 * ⭐ W32 (roadmap 12.10) — is this caller BANNED?
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **AN EMPTY LIST DENIES NOBODY — the exact opposite of `isAddressAllowed` directly above.**
 *
 * That is not an inconsistency to be tidied away; it is what the two lists mean. An allow-list is a
 * statement about who may act, so an empty one names nobody and must refuse everyone: a key whose
 * addresses were never configured is a key that should not work. A deny-list is a statement about who
 * may not, so an empty one names nobody and must refuse no one: a deployment where nobody has been
 * banned is the ordinary state, and refusing everybody would take the product off the air.
 *
 * ⛔ **Do not "harmonise" these.** Making the deny-list fail-closed locks every user out of a system
 * nobody attacked; making the allow-list fail-open hands a provisioning key to the internet. Both
 * mistakes look like a one-line consistency fix, which is why the two meanings are asserted side by
 * side in `tests/network/deny-list-semantics.spec.ts` with this reasoning attached.
 *
 * ⓘ A third meaning lives in `libs/common/src/mail/guards.ts` (outbound: empty = unrestricted). Three
 * lists, three defaults, each correct for its own question — the file headers cite each other so a
 * reader meeting the second one never has to guess whether the first was a mistake.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * An absent or blank address is NOT denied: we could not identify the caller, and a deny-list is a
 * statement about identified addresses. (The surfaces where "we could not tell who called" must
 * refuse are protected by the allow-list above, which does exactly that.)
 */
export function isAddressDenied(
  address: string | undefined | null,
  denyList: readonly string[],
): boolean {
  if (denyList.length === 0) return false;
  const candidate = normalise(address ?? '');
  if (candidate === '') return false;
  return parseIpAllowList(denyList).includes(candidate);
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
