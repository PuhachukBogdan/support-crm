import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { ViewAsController } from './view-as.controller';
import type { ViewAsContext } from '../security/view-as.context';
import type { RequestClaims } from './auth.guard';

/**
 * Feature 011 US5 (T047). The view-as control endpoints. The `platform.view_as` permission gate is
 * enforced by the global PermissionGuard (see permission.guard.spec — SC-009 write-block + previewed
 * resolve); here we cover the controller: enter stores the previewed role, exit clears it, and both
 * take the caller identity from validated claims only.
 */
function ctx() {
  const store = new Map<string, string>();
  const key = (a: string, u: string) => `${a}:${u}`;
  return {
    set: jest.fn(async (a: string, u: string, r: string) => void store.set(key(a, u), r)),
    clear: jest.fn(async (a: string, u: string) => void store.delete(key(a, u))),
    get: jest.fn(async (a: string, u: string) => store.get(key(a, u)) ?? null),
    _store: store,
  } as unknown as ViewAsContext & { _store: Map<string, string> };
}
const req = (claims?: RequestClaims) => ({ claims }) as Request & { claims?: RequestClaims };
const CLAIMS: RequestClaims = { userId: 'god-1', accountId: 'acct-1', roles: ['super_admin'] };

describe('ViewAsController', () => {
  it('enter: stores the previewed role for the caller and echoes it', async () => {
    const c = ctx();
    const out = await new ViewAsController(c).enter({ role: 'support_agent' }, req(CLAIMS));
    expect(out).toEqual({ previewing: 'support_agent' });
    expect(c.set).toHaveBeenCalledWith('acct-1', 'god-1', 'support_agent');
  });

  it('enter: rejects an empty role', async () => {
    await expect(new ViewAsController(ctx()).enter({ role: '  ' }, req(CLAIMS))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('enter/exit: no claims → forbidden (fail closed)', async () => {
    await expect(new ViewAsController(ctx()).enter({ role: 'am' }, req(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new ViewAsController(ctx()).exit(req(undefined))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('exit: clears the caller preview context', async () => {
    const c = ctx();
    await new ViewAsController(c).enter({ role: 'am' }, req(CLAIMS));
    const out = await new ViewAsController(c).exit(req(CLAIMS));
    expect(out).toEqual({ previewing: null });
    expect(c.clear).toHaveBeenCalledWith('acct-1', 'god-1');
  });
});
