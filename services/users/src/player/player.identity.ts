/**
 * T002 (feature 020, roadmap 5.2) — **the one place a player's identity is formed and compared.**
 *
 * ── The defect this exists to prevent ───────────────────────────────────────────────────────────
 * `Player` used to be keyed by `player_id` alone. GR8's `player_id` is unique only WITHIN a brand:
 * the same value under brand A and brand B is routinely **two different human beings**. So the old
 * key did not identify a person — it collided two of them into one row (one card, one VIP flag, one
 * set of AM notes), and the conversation feed then showed one customer another's messages.
 *
 * GR8's own contract says as much: `POST /players/find` answers with **`brand` alongside
 * `playerId`**, and treats **email/phone** as the person-level identifier. That document has been in
 * this repository since 2026-07-21 — four days AFTER ADR 0032 declared `player_id` globally unique.
 * Nobody re-read the decision when its source arrived.
 *
 * ── Why the identity lives here and nowhere else ────────────────────────────────────────────────
 * If the triple were assembled at each call site, "what identifies a player" would be a convention
 * rather than a definition, and the next surface would get it subtly wrong — which is exactly how
 * the previous key survived four phases. One definition, one test, one place to change.
 *
 * ── Brand is IDENTITY here, and still not AUTHORIZATION ─────────────────────────────────────────
 * ADR 0038 §1: one support department serves every brand, so no caller is ever refused because of a
 * brand. This module says **who a record is**, never **who may see it**.
 */

/** A player, fully identified. All three parts are required — none has a meaningful default. */
export interface PlayerIdentity {
  readonly accountId: string;
  readonly brandId: string;
  readonly playerId: string;
}

/** Thrown when an identity is incomplete. Names the missing PART, never the values. */
export class IncompletePlayerIdentityError extends Error {
  constructor(missing: string) {
    // No value is interpolated: a player id is customer-identifying and an error message is a log
    // line and a client response at the same time (SEC-26).
    super(`player identity is incomplete: ${missing} is required`);
    this.name = 'IncompletePlayerIdentityError';
  }
}

function require1(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IncompletePlayerIdentityError(name);
  }
  return value;
}

/**
 * Build an identity, refusing anything partial.
 *
 * A caller holding only a platform id **cannot** produce one, which is the point: the ambiguity is
 * refused where it arises rather than resolved by picking a record (FR-003).
 */
export function playerIdentity(parts: {
  accountId?: unknown;
  brandId?: unknown;
  playerId?: unknown;
}): PlayerIdentity {
  return {
    accountId: require1(parts.accountId, 'accountId'),
    brandId: require1(parts.brandId, 'brandId'),
    playerId: require1(parts.playerId, 'playerId'),
  };
}

/** The Prisma composite-key selector. Column order matches the primary key (account first). */
export function identityWhere(id: PlayerIdentity): {
  account_id_brand_id_player_id: { account_id: string; brand_id: string; player_id: string };
} {
  return {
    account_id_brand_id_player_id: {
      account_id: id.accountId,
      brand_id: id.brandId,
      player_id: id.playerId,
    },
  };
}

/** Two identities are the same player only when all three parts agree. */
export function sameIdentity(a: PlayerIdentity, b: PlayerIdentity): boolean {
  return a.accountId === b.accountId && a.brandId === b.brandId && a.playerId === b.playerId;
}

/**
 * A stable, human-readable rendering — for grouping in memory and for test output.
 *
 * NOT an identifier to store or to accept from a caller: parsing a joined string back into three
 * parts is how a delimiter in a brand id becomes a security bug. Storage uses the three columns.
 */
export function identityLabel(id: PlayerIdentity): string {
  return `${id.accountId}/${id.brandId}/${id.playerId}`;
}
