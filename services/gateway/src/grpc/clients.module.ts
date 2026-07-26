import { Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import {
  grpcClientOptions,
  AUTH_PACKAGE,
  AUTH_PROTO,
  HEALTH_PACKAGE,
  HEALTH_PROTO,
  PING_PACKAGE,
  PING_PROTO,
} from '@crm/common';

// Injection tokens for the gateway's gRPC client proxies (spec 003, US3 + US5).
export const PING_CLIENT = 'PING_CLIENT';
// Feature 009: the AuthService client (login/verify/refresh/logout/validate) — distinct from
// the health-only client above. The gateway's session edge dials this.
export const AUTH_CLIENT = 'AUTH_CLIENT';
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
