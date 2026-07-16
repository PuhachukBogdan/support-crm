import { PingRequest, PingResponse } from '@crm/proto';

// US4 / FR-004: consuming a GENERATED stub inside a service proves the schema-first
// loop (.proto -> buf/ts-proto codegen -> typed import -> build). This is a Phase-0
// smoke helper, not a real RPC handler (real gRPC wiring is Phase 2).
export function makeSamplePing(req: PingRequest): PingResponse {
  return {
    message: req.message,
    servedAt: new Date().toISOString(),
  };
}
