import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { ROLE_VISIBLE_TIERS, visibleTiersFor } from '@crm/common';

/**
 * WHO is narrowed to their own portfolio (feature 030, roadmap 4.14).
 *
 * ── The rule is 026's, reused rather than restated ───────────────────────────────────────────────
 *
 *     narrows  ⟺  role sees `am_only`  ∧  ¬ role sees `masked_pii`
 *
 * This is the same derivation `visibleTiersForSubject` performs for player fields, and it is imported
 * from the same place. ADR 0039 §2 forbids a **second mechanism that decides access**, and "which
 * conversations may this AM read" is the same question as "which players may they read about" asked one
 * table over — so it must not get its own answer.
 *
 * `masked_pii` **is** the administrative clearance: `admin` and `super_admin` are the only roles holding
 * it. Administrators therefore keep the full view (making an administrator attach themselves to read a
 * ticket would be theatre, and their reads are already audited), while `am` / `shift_am` are narrowed.
 * A hardcoded `['am','shift_am']` would drift the first time a role is added, and drift silently.
 *
 * ⚠️ **`open` and `operational` are untouched, deliberately.** An AM must still see enough of an
 * unattached player to attach them at all — 026 called that "the door opens from the inside", and
 * narrowing those tiers would make self-assignment unreachable.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * The role the caller is **acting as**.
 *
 * ⚠️ `x-actor-effective-role`, NOT `x-actor-role` — feature 018 added both precisely because reusing one
 * header for two meanings is the silent kind of change, and under an owner's view-as preview they differ.
 * A preview answers *"what can this ROLE do?"* (024's rule for the group term), so an owner previewing
 * `am` sees the narrowing applied. ⓘ Consequence worth knowing before it is reported as a bug: that
 * preview shows an **empty** queue, because the owner has no attachments — which is the truthful answer
 * for a preview of a role, not a defect.
 */
export function callerActingRole(md: Metadata | undefined): string {
  return readStr(md, 'x-actor-effective-role');
}

/**
 * Whether this caller's conversation reads are narrowed to their attached players.
 *
 * ⚠️ **An unreadable role NARROWS.** Both wrong answers cost something and they are not symmetric: read
 * as "not an AM" and a manager whose role header failed to arrive sees *every* conversation in the
 * account — the exact over-reach this point exists to remove, and invisible. Read as "narrowed" and
 * somebody sees an empty queue, which is visible within minutes and reported. Fail closed means choosing
 * the direction that fails safely, the same rule the presence decoder applies when it defaults to
 * `offline` rather than `online`.
 */
export function narrowsToPortfolio(md: Metadata | undefined): boolean {
  const role = callerActingRole(md);
  if (!role) return true;

  /**
   * ⚠️ **An UNKNOWN role narrows too, and this line is why the map is read directly.**
   * `visibleTiersFor` is fail-closed for *field* visibility — it silently answers `['open']` for a role
   * it does not know, which is the safe direction there. Here the same default is **fail-OPEN**: `open`
   * contains no `am_only`, so an unrecognised role would read as "not an AM" and see every conversation
   * in the account. A borrowed default is safe only in the question it was written for.
   */
  if (!Object.prototype.hasOwnProperty.call(ROLE_VISIBLE_TIERS, role)) return true;

  const tiers = visibleTiersFor(role);
  if (tiers.includes('masked_pii')) return false;
  return tiers.includes('am_only');
}

/** One attached customer: `(brand, player)`, never a bare platform id. */
export interface PortfolioMember {
  brandId: string;
  playerId: string;
}

/**
 * The predicate a conversation is tested against.
 *
 * ⚠️ **The PAIR, never `player_id` alone.** Since feature 020 a customer is `(account, brand, player_id)`
 * and the same platform id under two brands is routinely **two different human beings** — matching on the
 * id would put another person's conversations into this AM's queue, which is the collision ADR 0038 §3
 * already had to fix once. A narrowing whose whole purpose is privacy must not reintroduce it.
 *
 * ⚠️ **A conversation with no `player_id` is NOT in any portfolio.** About one in six carry none today
 * (roadmap 6.7 exists to give them an owner); they stay reachable on the paths that do not depend on
 * attachment, and they are absent from every portfolio stream by definition rather than by omission.
 */
export function inPortfolio(
  conversation: { brand_id?: string | null; player_id?: string | null },
  portfolio: readonly PortfolioMember[],
): boolean {
  const brandId = conversation.brand_id ?? '';
  const playerId = conversation.player_id ?? '';
  if (!brandId || !playerId) return false;
  return portfolio.some((m) => m.brandId === brandId && m.playerId === playerId);
}
