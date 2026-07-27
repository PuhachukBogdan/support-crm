/**
 * Shared gRPC transport helpers (spec 003-local-infra, research D3).
 *
 * NestJS loads the `.proto` files at runtime via `@grpc/proto-loader`; the ts-proto
 * `@crm/proto` types are used only to type handlers/clients. These helpers centralise
 * the package names, absolute proto paths, and loader options so every service and the
 * gateway wire gRPC identically (no drift).
 */
import { join } from 'node:path';
import { Transport } from '@nestjs/microservices';
import type { GrpcOptions } from '@nestjs/microservices';

// This file lives at libs/common/src/ ; the .proto tree lives at libs/proto/crm/**.
// The same relative layout holds from source (tsx / @swc/jest) and inside the Docker
// image (COPY . . preserves /app/libs/common/src and /app/libs/proto).
const PROTO_ROOT = join(__dirname, '..', '..', 'proto');

export const PING_PACKAGE = 'crm.ping.v1';
export const HEALTH_PACKAGE = 'crm.health.v1';
export const AUTH_PACKAGE = 'crm.auth.v1';
export const CHATS_PACKAGE = 'crm.chats.v1';
// Feature 015: the audit read surface is federated, so the gateway needs a FULL users client (it had
// only ping + health) and every service's proto now imports the shared audit shapes.
export const USERS_PACKAGE = 'crm.users.v1';
export const AUDIT_PACKAGE = 'crm.audit.v1';

export const PING_PROTO = join(PROTO_ROOT, 'crm', 'ping', 'v1', 'ping.proto');
export const HEALTH_PROTO = join(PROTO_ROOT, 'crm', 'health', 'v1', 'health.proto');
export const AUTH_PROTO = join(PROTO_ROOT, 'crm', 'auth', 'v1', 'auth.proto');
export const CHATS_PROTO = join(PROTO_ROOT, 'crm', 'chats', 'v1', 'chats.proto');
export const USERS_PROTO = join(PROTO_ROOT, 'crm', 'users', 'v1', 'users.proto');
export const AUDIT_PROTO = join(PROTO_ROOT, 'crm', 'audit', 'v1', 'audit.proto');

/**
 * proto-loader options shared by every server and client. `keepCase: false` makes the
 * runtime objects camelCase (e.g. `servedAt`) so they match the ts-proto interfaces.
 */
export const GRPC_LOADER = {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  // Feature 015: the first cross-file proto import (auth/users/chats each import the shared audit shapes).
  // Without this, proto-loader resolves `import "crm/audit/v1/audit.proto"` relative to the IMPORTING file's
  // directory and fails with a path like `crm/auth/v1/crm/audit/v1/audit.proto`. Caught by the existing
  // gateway boot tests, which is exactly what they are for.
  // Mutable array (not `readonly`) because proto-loader's option type demands `string[]`.
  includeDirs: [PROTO_ROOT] as string[],
} as const;

/**
 * Per-channel gRPC tuning (feature 016).
 *
 * Added because the two helpers below had FIXED signatures exposing no message-size setting, so the
 * uploads path could not raise its limit at the call site — the change had to happen here or not at
 * all. The parameter is OPTIONAL so the defaults for the other five services are untouched: a
 * repo-wide 12 MB ceiling would be a memory decision made for six services to serve one.
 */
export type GrpcChannelOptions = Record<string, unknown>;

/**
 * The uploads path's message ceiling (feature 016, research R2).
 *
 * 12 MB = the 10 MB attachment cap plus room for the protobuf framing and the request's other
 * fields. The memory arithmetic, so the number is not a mystery later: transport costs at most
 * `cap × 2 hops × concurrency` ≈ 10 MB × 2 × ~10 concurrent uploads ≈ **200 MB**, bounded and
 * stated rather than discovered.
 *
 * Applied ONLY to the users server and the clients that dial it for uploads. **Trigger to switch to
 * client-streaming**: a purpose needing more than 10 MB, or upload concurrency materially above the
 * agent count. The contract's header/bytes shape is already stream-compatible, so that is a
 * migration rather than a redesign.
 */
export const UPLOAD_CHANNEL_BYTES = 12 * 1024 * 1024;

export const UPLOAD_SERVER_CHANNEL_OPTIONS: GrpcChannelOptions = {
  'grpc.max_receive_message_length': UPLOAD_CHANNEL_BYTES,
  'grpc.max_send_message_length': UPLOAD_CHANNEL_BYTES,
};

export const UPLOAD_CLIENT_CHANNEL_OPTIONS: GrpcChannelOptions = {
  'grpc.max_send_message_length': UPLOAD_CHANNEL_BYTES,
  'grpc.max_receive_message_length': UPLOAD_CHANNEL_BYTES,
};

/** Options for `NestFactory.createMicroservice` — a service hosting one or more gRPC packages. */
export function grpcServerOptions(
  pkg: string | string[],
  protoPath: string | string[],
  url: string,
  channelOptions?: GrpcChannelOptions,
): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: pkg,
      protoPath,
      url,
      loader: GRPC_LOADER,
      ...(channelOptions ? { channelOptions } : {}),
    },
  };
}

/** Options object for a `ClientsModule.register` entry (the gateway dialing a service). */
export function grpcClientOptions(
  pkg: string,
  protoPath: string,
  url: string,
  channelOptions?: GrpcChannelOptions,
): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: {
      package: pkg,
      protoPath,
      url,
      loader: GRPC_LOADER,
      ...(channelOptions ? { channelOptions } : {}),
    },
  };
}
