import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { firstValueFrom, type Observable } from 'rxjs';

/**
 * gRPC → HTTP status mapping for the chats REST edge.
 *
 * Found by feature-012 Track B (live, 2026-07-26): the chats service correctly answers
 * `NOT_FOUND` for a conversation outside the caller's account (isolation held — no data was
 * returned), but the gateway let the raw gRPC error escape, so the client got **500** plus a stack
 * trace in the logs. Track-A specs mock `ClientGrpc` with `of(...)` and never exercise the error
 * path, which is why only a live run surfaced it.
 *
 * Mapping is deliberately coarse and message-free: the client learns the class of failure, never
 * the downstream detail (no PII, no internals — SC-007). NOT_FOUND and PERMISSION_DENIED are both
 * legitimate answers for "not yours", and neither may distinguish "exists elsewhere" from
 * "does not exist".
 */

/** grpc-js status codes we translate (see @grpc/grpc-js `status`). */
const GRPC = {
  INVALID_ARGUMENT: 3,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  UNAUTHENTICATED: 16,
} as const;

const isRpcError = (e: unknown): e is { code?: number } =>
  typeof e === 'object' && e !== null && 'code' in e;

function toHttp(err: unknown): HttpException {
  // An HttpException raised locally (e.g. by the wire validators) passes through untouched.
  if (err instanceof HttpException) return err;
  const code = isRpcError(err) ? err.code : undefined;
  switch (code) {
    case GRPC.NOT_FOUND:
      return new NotFoundException('not found');
    // Feature 013 added uniqueness conflicts (duplicate label / macro / canned-response name).
    // Found by Track B: without this case a plain duplicate name surfaced as a 500.
    case GRPC.ALREADY_EXISTS:
      return new ConflictException('already exists');
    case GRPC.PERMISSION_DENIED:
      return new ForbiddenException('forbidden');
    case GRPC.UNAUTHENTICATED:
      return new UnauthorizedException('unauthorized');
    case GRPC.INVALID_ARGUMENT:
    case GRPC.FAILED_PRECONDITION:
      return new BadRequestException('invalid request');
    case GRPC.RESOURCE_EXHAUSTED:
      return new HttpException('too many requests', 429);
    default:
      // Unknown/UNAVAILABLE/INTERNAL → generic 500; the cause stays in our logs, not in the body.
      return new InternalServerErrorException('upstream error');
  }
}

/** Await a chats RPC, translating gRPC failures into HTTP-shaped errors. */
export async function callChats<T>(call: Observable<T>): Promise<T> {
  try {
    return await firstValueFrom(call);
  } catch (err) {
    throw toHttp(err);
  }
}
