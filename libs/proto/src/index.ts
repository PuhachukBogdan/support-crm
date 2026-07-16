/**
 * @crm/proto — barrel for generated inter-service contract stubs.
 *
 * The `../gen/**` files are produced by `npm run proto:gen` (buf + ts-proto) and are
 * git-ignored — regenerate, never hand-edit. Phase 0 ships one trivial `Ping` contract
 * to prove the schema-first generate → import → build loop (FR-004). Real contracts
 * arrive in Phase 2 (roadmap 2.1).
 */
export * from '../gen/crm/ping/v1/ping';
