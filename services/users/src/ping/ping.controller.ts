import { Controller } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { PingRequest, PingResponse } from '@crm/proto';

/**
 * gRPC `PingService.Ping` (spec 003, US3). The `users` service is the downstream the
 * gateway round-trips to over the internal network. `servedAt` is stamped HERE so the
 * gateway response proves the value crossed the wire (not a locally faked one) — FR-007.
 * Replaces the Phase-0 in-process ping.sample helper.
 */
@Controller()
export class PingGrpcController {
  @GrpcMethod('PingService', 'Ping')
  ping(request: PingRequest): PingResponse {
    return {
      message: request.message,
      servedAt: new Date().toISOString(),
    };
  }
}
