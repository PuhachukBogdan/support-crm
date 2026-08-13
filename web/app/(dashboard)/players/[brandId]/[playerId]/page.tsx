import { PlayerPage } from '@/features/contacts/player-page';

/**
 * The full player page (block W11, roadmap 9.17 — the page half; distinct from 9.4's PANEL, which
 * lives beside a conversation).
 *
 * ⚠️ **TWO path segments, and that is the contract, not a style choice.** A player id alone names
 * two different human beings when the same platform id exists under two brands (the 2026-07-29
 * Person repair), so the brand travels in the URL beside it. It also keeps the route clear of the
 * single-segment `[module]` catch-all.
 */
export default async function Page({
  params,
}: {
  params: Promise<{ brandId: string; playerId: string }>;
}) {
  const { brandId, playerId } = await params;
  return <PlayerPage brandId={brandId} playerId={playerId} />;
}
