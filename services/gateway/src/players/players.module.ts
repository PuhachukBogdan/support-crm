import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { BrandsController } from '../brands/brands.controller';
import { PlayersController } from './players.controller';

/**
 * Gateway players + operators read edge (feature 018, roadmap 5.1).
 *
 * Thin by construction, like the uploads and exports edges beside it. The only judgement in this folder is
 * request parsing (`wire.ts`); masking, the bulk-read guard, account isolation and the access audit are all
 * decided in the owning service. The gateway routes and forwards — it holds no business logic (ADR 0029).
 *
 * Reuses the existing users client rather than registering a second one.
 */
@Module({
  imports: [GrpcClientsModule],
  // W11 (9.17): the brands list rides this edge — it exists to answer the player reads' required
  // `brandId`, so it belongs beside them rather than in a module of its own.
  controllers: [PlayersController, BrandsController],
})
export class PlayersEdgeModule {}
