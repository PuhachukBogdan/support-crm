import { NetworkEdgeModule } from '../network/network.module';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { RedisModule } from '../redis/redis.module';
import { GATEWAY_CONFIG, loadGatewayConfig } from '../config';

/**
 * WebSocket surface at the single ingress (spec 003, US4 · feature 034 W4).
 *
 * ⭐ **ONE gateway class, one path.** `IngressGateway` was folded into `RealtimeGateway` on 2026-08-05: two
 * `@WebSocketGateway` classes sharing `path: '/ws'` closed every handshake without ever running
 * `handleConnection`. Spec 003's `ping`/`pong` survives inside it, which is what still proves REST and
 * realtime answer on the same port.
 */
@Module({
  // ⭐ W32: the deny-list cache, because the HTTP middleware cannot reach a WebSocket upgrade.
  imports: [RedisModule, JwtModule.register({}), NetworkEdgeModule],
  providers: [
    RealtimeGateway,
    // The socket verifies the token with the same secret the HTTP guard does, so it needs the same config.
    { provide: GATEWAY_CONFIG, useFactory: () => loadGatewayConfig() },
  ],
})
export class WsModule {}
