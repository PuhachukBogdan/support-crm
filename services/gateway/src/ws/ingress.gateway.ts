import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

/**
 * Minimal WebSocket surface on the gateway (spec 003, US4 / FR-009). Its only job here is
 * to prove that REST and realtime share the SAME host/port through the single ingress —
 * real realtime (presence, conversation streams, scoped broadcasts) arrives in Phase 7.
 *
 * With the native `ws` adapter, clients send `{"event":"ping","data":...}`; this replies
 * `{"event":"pong","data":...}`.
 */
@WebSocketGateway()
export class IngressGateway {
  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: unknown): { event: 'pong'; data: unknown } {
    return { event: 'pong', data: data ?? null };
  }
}
