/**
 * @crm/proto — barrel for generated inter-service contract stubs.
 *
 * The `../gen/**` files are produced by `npm run proto:gen` (buf + ts-proto) and are
 * git-ignored — regenerate, never hand-edit. Phase 0 ships one trivial `Ping` contract
 * to prove the schema-first generate → import → build loop (FR-004). Real contracts
 * arrive in Phase 2 (roadmap 2.1).
 */
export * from '../gen/crm/ping/v1/ping';
// Health readiness contract (spec 003-local-infra, US5). Explicit named re-exports — the
// generated file also emits ts-proto helpers (DeepPartial/Exact/MessageFns/protobufPackage)
// that would collide with ping's `export *`. NestJS loads the .proto at runtime via
// proto-loader (see the @crm/common grpc helper); these are the message types only.
export {
  HealthCheckRequest,
  HealthCheckResponse,
  DependencyStatus,
} from '../gen/crm/health/v1/health';

// --- Phase 2 inter-service contracts (feature 006, roadmap 2.1) ---
// Named re-exports (each generated file emits its own ts-proto helpers that would collide
// under `export *`). Message types only — NestJS loads the .proto at runtime via proto-loader.

// Auth <-> Gateway
export {
  ValidateTokenRequest,
  TokenClaims,
  LoginRequest,
  RefreshRequest,
  TokenPair,
} from '../gen/crm/auth/v1/auth';

// Chats <-> Users (players/operators, read-only)
export {
  GetPlayerRequest,
  GetOperatorRequest,
  ListPlayersByBrandRequest,
  Player,
  Operator,
  PlayerPage,
} from '../gen/crm/users/v1/users';

// Chats <-> Brands (identity + access checks, read-only)
export {
  GetBrandRequest,
  Brand,
  CheckBrandAccessRequest,
  BrandAccessResult,
} from '../gen/crm/brands/v1/brands';
