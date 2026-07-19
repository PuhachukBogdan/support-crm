import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Read path for the Player entity (feature 006 US3, roadmap 2.7). Keyed by the domain
 * `player_id`; includes the brand-union edges so callers get ONE unified player across 1..N
 * brands (ADR 0032 §0.1). The GR8 snapshot is returned verbatim (opaque) — no typing here.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata, so the DI
 * token must be explicit (Phase-1 gotcha).
 */
@Injectable()
export class PlayerRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Unified read by domain key; null when the player is unknown. */
  getPlayerById(playerId: string) {
    return this.prisma.player.findUnique({
      where: { player_id: playerId },
      include: { brands: true },
    });
  }
}
