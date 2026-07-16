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

export const PING_PROTO = join(PROTO_ROOT, 'crm', 'ping', 'v1', 'ping.proto');
export const HEALTH_PROTO = join(PROTO_ROOT, 'crm', 'health', 'v1', 'health.proto');

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
} as const;

/** Options for `NestFactory.createMicroservice` — a service hosting one or more gRPC packages. */
export function grpcServerOptions(
  pkg: string | string[],
  protoPath: string | string[],
  url: string,
): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: { package: pkg, protoPath, url, loader: GRPC_LOADER },
  };
}

/** Options object for a `ClientsModule.register` entry (the gateway dialing a service). */
export function grpcClientOptions(pkg: string, protoPath: string, url: string): GrpcOptions {
  return {
    transport: Transport.GRPC,
    options: { package: pkg, protoPath, url, loader: GRPC_LOADER },
  };
}
