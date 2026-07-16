import { Module } from '@nestjs/common';
import { IngressGateway } from './ingress.gateway';

// WebSocket surface at the single ingress (spec 003, US4).
@Module({
  providers: [IngressGateway],
})
export class WsModule {}
