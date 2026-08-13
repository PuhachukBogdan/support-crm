import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { IngressGateway } from './ingress.gateway';
import { RealtimeGateway } from './realtime.gateway';
import { RedisModule } from '../redis/redis.module';
import { GATEWAY_CONFIG, loadGatewayConfig } from '../config';

/**
 * WebSocket surface at the single ingress (spec 003, US4 · feature 034 W4).
 *
 * `IngressGateway` stays: its `ping`/`pong` is the proof that REST and realtime share one host and port,
 * which is the property spec 003 asserted and nothing else does. `RealtimeGateway` is the actual surface —
 * authorized at the handshake, rooms per account, payload forwarded unchanged.
 *
 * ⚠️ Both are declared on the same `@WebSocketGateway()` path deliberately: one socket per browser carries
 * both, so a client does not open a second connection to say "ping".
 */
@Module({
  imports: [RedisModule, JwtModule.register({})],
  providers: [
    IngressGateway,
    RealtimeGateway,
    // The socket verifies the token with the same secret the HTTP guard does, so it needs the same config.
    { provide: GATEWAY_CONFIG, useFactory: () => loadGatewayConfig() },
  ],
})
export class WsModule {}
