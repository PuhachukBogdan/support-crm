/** W15 (roadmap 6.8 minimum, subpoint 3.10) — the channels admin screen's wire shapes. */

export interface ChannelWire {
  id: string;
  brandId: string;
  /** `api | email | messenger` — the stored kind, a closed vocabulary. */
  kind: string;
  /**
   * The channel's public identifier — what a delivery names (`/channels/{key}/inbound`) and what the
   * mailbox reader is configured with. NOT a secret: the secret lives in deployment configuration,
   * looked up BY this key, and has no column this wire could have read it from.
   */
  key: string;
  /** The channel's OWN address (an email channel's mailbox) — ours, not a customer's. `''` when none. */
  address: string;
  enabled: boolean;
}

/** The slice of `/brands` this screen joins on — names, because a table of brand UUIDs is unreadable. */
export interface BrandWire {
  brandId: string;
  name: string;
}
