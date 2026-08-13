import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import {
  grpcClientOptions,
  AUTH_PACKAGE,
  AUTH_PROTO,
  BRANDS_PACKAGE,
  BRANDS_PROTO,
  CHATS_PACKAGE,
  CHATS_PROTO,
  USERS_PACKAGE,
  USERS_PROTO,
  HEALTH_PACKAGE,
  HEALTH_PROTO,
  PING_PACKAGE,
  PING_PROTO,
  UPLOAD_CLIENT_CHANNEL_OPTIONS,
} from '@crm/common';

// Injection tokens for the gateway's gRPC client proxies (spec 003, US3 + US5).
export const PING_CLIENT = 'PING_CLIENT';
// Feature 009: the AuthService client (login/verify/refresh/logout/validate) — distinct from
// the health-only client above. The gateway's session edge dials this.
export const AUTH_CLIENT = 'AUTH_CLIENT';
// Feature 012: the chats-core client (ChatsReadService + ChatsWriteService) — the inbox/
// conversation/message/feed edge dials this.
export const CHATS_CLIENT = 'CHATS_CLIENT';
/** W11 (9.17): the brands READ surface — the directory's brand chooser has nothing without it. */
export const BRANDS_CLIENT = 'BRANDS_CLIENT';
// Feature 015: the audit read is federated across auth + users + chats, so the gateway needs a FULL users
// client — until now it dialed users only for ping and health.
export const USERS_CLIENT = 'USERS_CLIENT';
export const AUTH_HEALTH_CLIENT = 'AUTH_HEALTH_CLIENT';
export const USERS_HEALTH_CLIENT = 'USERS_HEALTH_CLIENT';
export const CHATS_HEALTH_CLIENT = 'CHATS_HEALTH_CLIENT';
export const BRANDS_HEALTH_CLIENT = 'BRANDS_HEALTH_CLIENT';
export const WORKER_HEALTH_CLIENT = 'WORKER_HEALTH_CLIENT';

// One health client per backend service (dial targets validated by loadGatewayConfig before
// this module is instantiated) + one ping client to the users service. proto-loader dials
// lazily, so registration never blocks boot when a service is down.
const HEALTH_TARGETS: Array<[string, string]> = [
  [AUTH_HEALTH_CLIENT, 'AUTH_GRPC_TARGET'],
  [USERS_HEALTH_CLIENT, 'USERS_GRPC_TARGET'],
  [CHATS_HEALTH_CLIENT, 'CHATS_GRPC_TARGET'],
  [BRANDS_HEALTH_CLIENT, 'BRANDS_GRPC_TARGET'],
  [WORKER_HEALTH_CLIENT, 'WORKER_GRPC_TARGET'],
];

@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: PING_CLIENT,
        useFactory: () =>
          grpcClientOptions(PING_PACKAGE, PING_PROTO, process.env.USERS_GRPC_TARGET as string),
      },
      {
        // Full AuthService surface (feature 009) — the session edge dials this for
        // login/verify/refresh/logout; per-request auth uses local JWT verify (Principle VII).
        name: AUTH_CLIENT,
        useFactory: () =>
          grpcClientOptions(AUTH_PACKAGE, AUTH_PROTO, process.env.AUTH_GRPC_TARGET as string),
      },
      {
        /**
         * ⭐ W11 (roadmap 9.17) — the brands READ surface. Until now the gateway dialled `brands`
         * only for readiness, and the web had no way to learn which brands exist: every read that
         * needs one (the player list, the card) takes `brandId` as a REQUIRED parameter, so the
         * customer directory literally could not ask its first question. One list, unpaged — an
         * account has single digits of brands (the service says so at its own handler).
         *
         * ⚠️ A brand is a FILTER, not a scope (ADR 0038 §1): knowing the list grants nothing, and
         * this client must never become a place where brand-based access is decided.
         */
        name: BRANDS_CLIENT,
        useFactory: () =>
          grpcClientOptions(BRANDS_PACKAGE, BRANDS_PROTO, process.env.BRANDS_GRPC_TARGET as string),
      },
      {
        // Chats-core surface (feature 012) — conversations/messages/player-feed reads + writes.
        name: CHATS_CLIENT,
        useFactory: () =>
          grpcClientOptions(CHATS_PACKAGE, CHATS_PROTO, process.env.CHATS_GRPC_TARGET as string),
      },
      {
        // Users read surface (feature 015) — ListAuditEntries; the player reads land in Phase 5.
        // Feature 016 adds `UploadsService` on the same package, which carries whole files, so this
        // client's message ceiling is raised to 12 MB. The gateway gains a message SIZE here and
        // still gains no storage configuration — that remains users-only (research R2/R10).
        name: USERS_CLIENT,
        useFactory: () =>
          grpcClientOptions(
            USERS_PACKAGE,
            USERS_PROTO,
            process.env.USERS_GRPC_TARGET as string,
            UPLOAD_CLIENT_CHANNEL_OPTIONS,
          ),
      },
      ...HEALTH_TARGETS.map(([token, envVar]) => ({
        name: token,
        useFactory: () =>
          grpcClientOptions(HEALTH_PACKAGE, HEALTH_PROTO, process.env[envVar] as string),
      })),
    ]),
  ],
  exports: [ClientsModule],
})
export class GrpcClientsModule {}
