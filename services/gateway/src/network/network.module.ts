import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { DeniedAddressCache } from './denied-address.cache';
import { DeniedAddressesController } from './denied-addresses.controller';

/**
 * ⭐ W32 (roadmap 12.10) — the deny-list at the boundary.
 *
 * The cache is EXPORTED because two very different consumers need the same list: the express
 * middleware that runs before routing (`main.ts`) and the WebSocket connection handler, which the
 * middleware cannot reach. One list, one address helper, two call sites — asserted by a test, because
 * a ban that covers the pages and leaves the live event feed open is worse than no ban at all.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [DeniedAddressesController],
  providers: [DeniedAddressCache],
  exports: [DeniedAddressCache],
})
export class NetworkEdgeModule {}
