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
 * gRPC → HTTP status mapping for the uploads REST edge (feature 016, T049).
 *
 * The same lesson feature 012's Track B taught, applied before it can be re-learned: the service
 * correctly answers `NOT_FOUND` for a resource outside the caller's account, and if the gateway lets
 * the raw gRPC error escape the client gets a **500 with a stack trace**. Track-A specs mock
 * `ClientGrpc` with `of(...)` and never exercise the error path, which is why only a live run
 * surfaced it there — so the mapping exists from the start here, and `serve.spec.ts` exercises it.
 *
 * Deliberately coarse and message-free. The client learns the CLASS of failure and never the
 * downstream detail: no filename, no storage key, no internals (SC-007). `NOT_FOUND` and
 * `PERMISSION_DENIED` are both legitimate answers for "not yours", and neither may distinguish
 * "exists elsewhere" from "does not exist" (FR-011).
 */
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

export function toHttp(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  const code = isRpcError(err) ? err.code : undefined;
  switch (code) {
    case GRPC.NOT_FOUND:
      return new NotFoundException('not found');
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
      return new InternalServerErrorException('upstream error');
  }
}

/** Await an uploads RPC, translating gRPC failures into HTTP-shaped errors. */
export async function callUploads<T>(call: Observable<T>): Promise<T> {
  try {
    return await firstValueFrom(call);
  } catch (err) {
    throw toHttp(err);
  }
}
