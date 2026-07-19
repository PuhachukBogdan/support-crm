import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Read path for the Player entity (feature 006 US3, roadmap 2.7). Keyed by the domain
 * `player_id`; includes the brand-union edges so callers get ONE unified player across 1..N
 * brands (ADR 0032 §0.1). The GR8 snapshot is returned verbatim (opaque) — no typing here.
 *
 * Feature 007: the read runs under the account-scoped client (`forAccount`), so the player is
 * confined to the caller's account (Principle I) — while the brand-union is preserved (the
 * player-union brand exception is brand-level, never account-level). The `accountId` is supplied
 * by the caller; until Auth (Phase 3) authenticates it, callers/tests pass it explicitly.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata, so the DI
 * token must be explicit (Phase-1 gotcha).
 */
@Injectable()
export class PlayerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Unified, account-scoped read by domain key; null when the player is unknown in this account. */
  getPlayerById(accountId: string, playerId: string) {
    return this.prisma.forAccount(accountId).player.findUnique({
      where: { player_id: playerId },
      include: { brands: true },
    });
  }
}
