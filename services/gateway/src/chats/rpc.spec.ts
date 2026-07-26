import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { callChats } from './rpc';

/** A grpc-js style error: a plain object carrying a numeric `code`. */
const rpcError = (code: number, details = 'not found') =>
  Object.assign(new Error(`${code} ${details}`), { code, details });

/**
 * Regression spec for the second Track-B finding (live, 2026-07-26): the chats service answered
 * gRPC NOT_FOUND for a conversation belonging to another account (isolation held), but the gateway
 * let the raw error escape as a **500** with a stack trace. Track-A controller specs mock the gRPC
 * client with `of(...)`, so the error path was never exercised.
 */
describe('callChats — gRPC → HTTP mapping', () => {
  it('passes a successful value through unchanged', async () => {
    await expect(callChats(of({ id: 'c1' }))).resolves.toEqual({ id: 'c1' });
  });

  it('maps NOT_FOUND (5) to 404 — the cross-account read case', async () => {
    const err = await callChats(throwError(() => rpcError(5))).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as HttpException).getStatus()).toBe(404);
  });

  // Found by feature-013 Track B: a duplicate label/macro/canned name (the service answers
  // ALREADY_EXISTS) had no case here, so an ordinary uniqueness conflict surfaced as a 500.
  it('maps ALREADY_EXISTS (6) to 409 — a duplicate name is a conflict, not a server error', async () => {
    const err = await callChats(throwError(() => rpcError(6, 'label name already used'))).catch(
      (e) => e,
    );
    expect((err as HttpException).getStatus()).toBe(409);
  });

  it('maps PERMISSION_DENIED (7) to 403', async () => {
    const err = await callChats(throwError(() => rpcError(7, 'forbidden'))).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('maps UNAUTHENTICATED (16) to 401', async () => {
    const err = await callChats(throwError(() => rpcError(16))).catch((e) => e);
    expect(err).toBeInstanceOf(UnauthorizedException);
  });

  it.each([3, 9])('maps INVALID_ARGUMENT / FAILED_PRECONDITION (%i) to 400', async (code) => {
    const err = await callChats(throwError(() => rpcError(code))).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it('maps RESOURCE_EXHAUSTED (8) to 429', async () => {
    const err = await callChats(throwError(() => rpcError(8))).catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it.each([2, 13, 14, undefined])('maps unknown/internal (%p) to a generic 500', async (code) => {
    const thrown = code === undefined ? new Error('boom') : rpcError(code);
    const err = await callChats(throwError(() => thrown)).catch((e) => e);
    expect(err).toBeInstanceOf(InternalServerErrorException);
  });

  it('never leaks downstream detail into the HTTP body (SC-007)', async () => {
    const leaky = rpcError(2, 'connect ECONNREFUSED 10.0.0.5:50053 while reading player seed-001');
    const err = (await callChats(throwError(() => leaky)).catch((e) => e)) as HttpException;
    const body = JSON.stringify(err.getResponse());
    expect(body).not.toContain('ECONNREFUSED');
    expect(body).not.toContain('10.0.0.5');
    expect(body).not.toContain('seed-001');
  });

  it('lets a locally-raised HttpException (e.g. wire validation) through untouched', async () => {
    const local = new BadRequestException('invalid kind: expected one of reply | note');
    const err = await callChats(throwError(() => local)).catch((e) => e);
    expect(err).toBe(local);
  });
});
