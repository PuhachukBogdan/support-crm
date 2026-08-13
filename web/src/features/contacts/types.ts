/** W11 (roadmap 9.17) — the wire shapes the customer directory reads. */

/** `GET /brands` — what the chooser offers. A brand is a filter, never an access dimension. */
export interface BrandWire {
  brandId: string;
  name: string;
  slug: string;
}

/**
 * A directory row — the player list's projection, masked per role by the server.
 *
 * ⚠️ There is NO customer name at any tier: the product stores none, it lives in GR8 (research R9,
 * roadmap 5.4). The columns are the ids and whatever the caller's tier permits — and absence is
 * ambiguous by design (proto defaults are dropped AND withheld fields are absent), so the screen
 * decides what to RENDER from the role, never from emptiness.
 */
export interface DirectoryRow {
  playerId: string;
  accountId: string;
  brandId: string;
  brandIds?: string[];
  personId?: string;
  vip?: boolean;
  segment?: string;
}
