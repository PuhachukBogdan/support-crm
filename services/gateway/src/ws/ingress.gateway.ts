import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

/**
 * Minimal WebSocket surface on the gateway (spec 003, US4 / FR-009). Its only job here is
 * to prove that REST and realtime share the SAME host/port through the single ingress —
 * real realtime (presence, conversation streams, scoped broadcasts) arrives in Phase 7.
 *
 * With the native `ws` adapter, clients send `{"event":"ping","data":...}`; this replies
 * `{"event":"pong","data":...}`.
 */
/**
 * ⚠️ **`/ws`, the same path as `RealtimeGateway` — and sharing it is the point.**
 *
 * When the realtime gateway moved to an explicit path (so a reverse proxy can route it), leaving this one on
 * `/` would have re-opened an UNAUTHENTICATED socket surface: nothing would have been handling the root
 * path's handshake, and this gateway accepts anybody. One path, authorized once, carrying both — which is
 * also what spec 003's US4 claim needs, since a browser opens one connection and not two.
 */
@WebSocketGateway({ path: '/ws' })
export class IngressGateway {
  @SubscribeMessage('ping')
  handlePing(@MessageBody() data: unknown): { event: 'pong'; data: unknown } {
    return { event: 'pong', data: data ?? null };
  }
}
