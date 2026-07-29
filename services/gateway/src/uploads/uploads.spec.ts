import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type { EffectivePermissions } from '@crm/common';
import { UPLOAD_PURPOSES } from '@crm/common';
import { PermissionGuard } from '../security/permission.guard';
import { EffectivePermsCache } from '../security/effective-perms.cache';
import { ViewAsContext } from '../security/view-as.context';
import 'reflect-metadata';
import {
  ALLOW_UNDER_PREVIEW_KEY,
  REQUIRED_PERMISSION_KEY,
  REQUIRES_PURPOSE_PARAM_KEY,
  RESOLVE_PERMISSIONS_KEY,
} from '../security/requires-permission.decorator';
import { UploadParseInterceptor } from './upload-parse.interceptor';
import { UploadsController } from './uploads.controller';

/**
 * T026 (feature 016, US1) — the upload SURFACE refuses before it does anything (SC-002 / SEC-1).
 *
 * The three properties under test are the ones that make the ingest a single guarded path rather
 * than a route with checks bolted on:
 *   • no session, no account ⇒ refused, and refused by the tier that runs before the handler;
 *   • an unknown purpose ⇒ refused BEFORE parsing begins (research R3), so an oversized body sent to
 *     a nonsense URL is never read;
 *   • the enforced permission is THE ONE THE PURPOSE NAMES — which is exactly what a static
 *     `@RequiresPermission` could not express, and the reason `@RequiresPurposePermission` exists.
 */
const CLAIMS = { userId: 'u-1', accountId: 'acct-1', roles: ['support_agent'] };

function eff(keys: string[]): EffectivePermissions {
  return {
    roleKey: 'support_agent',
    permissionKeys: keys,
    mode: 'inherited',
    isPreview: false,
    readOnly: false,
  };
}

function makeGuard(cacheHit: EffectivePermissions | null) {
  const cache = {
    get: jest.fn().mockResolvedValue(cacheHit),
    set: jest.fn().mockResolvedValue(undefined),
  } as unknown as EffectivePermsCache;
  const client = {
    getService: () => ({ resolveEffectivePermissions: jest.fn(() => of({ permissionKeys: [] })) }),
  } as unknown as ClientGrpc;
  const viewAs = { get: jest.fn().mockResolvedValue(null) } as unknown as ViewAsContext;
  const reflector = new Reflector();
  const guard = new PermissionGuard(reflector, client, cache, viewAs);
  guard.onModuleInit();
  return { guard, reflector };
}

function purposeContext(
  reflector: Reflector,
  req: { claims?: typeof CLAIMS; params?: Record<string, string>; method?: string },
): ExecutionContext {
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
    if (key === REQUIRES_PURPOSE_PARAM_KEY) return 'purpose';
    if (key === REQUIRED_PERMISSION_KEY) return undefined;
    if (key === ALLOW_UNDER_PREVIEW_KEY) return undefined;
    return undefined;
  });
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('*** the permission enforced is the one the PURPOSE names *** (T033a)', () => {
  it('message_attachment demands crm.conversation.reply', async () => {
    const { guard, reflector } = makeGuard(eff(['crm.conversation.reply']));
    const ctx = purposeContext(reflector, {
      claims: CLAIMS,
      params: { purpose: 'message_attachment' },
      method: 'POST',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('…and refuses without it', async () => {
    const { guard, reflector } = makeGuard(eff(['crm.inbox.view']));
    const ctx = purposeContext(reflector, {
      claims: CLAIMS,
      params: { purpose: 'message_attachment' },
      method: 'POST',
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('avatar (permission: null) is allowed for any AUTHENTICATED caller', async () => {
    // `null` means "authenticated is sufficient" — a real check that has already passed, never a
    // skipped one. Setting your own avatar does not warrant a catalogue key (research R11).
    const { guard, reflector } = makeGuard(eff([]));
    const ctx = purposeContext(reflector, {
      claims: CLAIMS,
      params: { purpose: 'avatar' },
      method: 'POST',
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('*** …and is still refused when UNAUTHENTICATED *** (SC-002 / SEC-1)', async () => {
    // The whole of SEC-1 in one assertion: the permissive-looking purpose must not be a hole.
    const { guard, reflector } = makeGuard(eff([]));
    const ctx = purposeContext(reflector, { params: { purpose: 'avatar' }, method: 'POST' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('an account-less caller is refused on every purpose', async () => {
    for (const purpose of Object.keys(UPLOAD_PURPOSES)) {
      const { guard, reflector } = makeGuard(eff(['crm.conversation.reply']));
      const ctx = purposeContext(reflector, { params: { purpose }, method: 'POST' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('an unknown purpose is refused at the guard, as 404 rather than 403', async () => {
    // The catalogue is closed and its shape is not a secret, so "no such purpose" is the honest
    // answer; 403 would make a typo look like a policy problem.
    const { guard, reflector } = makeGuard(eff(['crm.conversation.reply']));
    const ctx = purposeContext(reflector, {
      claims: CLAIMS,
      params: { purpose: 'nonsense' },
      method: 'POST',
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('*** an unknown purpose is refused BEFORE parsing begins *** (FR-002 / research R3)', () => {
  function interceptorContext(purpose: string) {
    return {
      switchToHttp: () => ({ getRequest: () => ({ params: { purpose } }) }),
    } as unknown as ExecutionContext;
  }

  it('the parse interceptor refuses without touching the body', async () => {
    const interceptor = new UploadParseInterceptor();
    const next = { handle: jest.fn() };
    await expect(
      interceptor.intercept(interceptorContext('nonsense'), next),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Nothing downstream ran, and no body was read: the limit has to be known before parsing, and
    // for an unknown purpose there is no limit to know.
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('the limit it would apply is the PURPOSE’s, not a global maximum', () => {
    // Asserted on the catalogue rather than on multer's internals: the property that matters is that
    // a 3 MB avatar and a 3 MB attachment get different answers from the same code.
    expect(UPLOAD_PURPOSES.avatar.maxBytes).toBe(2 * 1024 * 1024);
    expect(UPLOAD_PURPOSES.message_attachment.maxBytes).toBe(10 * 1024 * 1024);
    expect(UPLOAD_PURPOSES.avatar.maxBytes).toBeLessThan(
      UPLOAD_PURPOSES.message_attachment.maxBytes,
    );
  });
});

describe('*** every uploads route FORWARDS the caller’s permissions *** (found live, Track B)', () => {
  /**
   * The defect this pins: the guard populates `req.effective` only for routes carrying permission
   * metadata, and `buildActorMetadata` reads exactly that to fill `x-actor-permissions`. The two GET
   * routes deliberately enforce no key at the gateway — the required key lives in the stored row —
   * so they carried no metadata at all, forwarded an EMPTY permission set, and `users` correctly
   * refused every read. A 403 on a file the caller owned.
   *
   * Both tiers had thorough specs and both were right. What was wrong was the WIRE between them, so
   * the regression test is about the wire: every route on this controller must cause the guard to
   * resolve permissions, whether or not it enforces one.
   */
  const ROUTE_METHODS = ['create', 'read', 'thumb'] as const;

  it.each(ROUTE_METHODS)('%s carries permission metadata of some kind', (method) => {
    const handler = (UploadsController.prototype as unknown as Record<string, object>)[method]!;
    const enforces =
      Reflect.getMetadata(REQUIRES_PURPOSE_PARAM_KEY, handler) ??
      Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler);
    const resolves = Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler);
    expect({ method, wired: !!(enforces || resolves) }).toEqual({ method, wired: true });
  });

  it('the GET routes resolve WITHOUT enforcing a static key (the decision is the service’s)', () => {
    for (const method of ['read', 'thumb'] as const) {
      const handler = (UploadsController.prototype as unknown as Record<string, object>)[method]!;
      expect(Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler)).toBe(true);
      // A static key here would be wrong for every purpose but one.
      expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler)).toBeUndefined();
    }
  });

  it('POST enforces the purpose’s key rather than merely resolving', () => {
    const handler = (UploadsController.prototype as unknown as Record<string, object>).create!;
    expect(Reflect.getMetadata(REQUIRES_PURPOSE_PARAM_KEY, handler)).toBe('purpose');
  });

  it('the guard resolves for a resolve-only route, so metadata is populated downstream', async () => {
    const { guard, reflector } = makeGuard(eff(['crm.conversation.reply']));
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === RESOLVE_PERMISSIONS_KEY) return true;
      return undefined;
    });
    const req: { claims?: typeof CLAIMS; effective?: EffectivePermissions } = { claims: CLAIMS };
    const ctx = {
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // THE assertion. Without this the request reaches `buildActorMetadata` with nothing to send.
    expect(req.effective?.permissionKeys).toEqual(['crm.conversation.reply']);
  });

  it('…and still refuses an unauthenticated caller', () => {
    const { guard, reflector } = makeGuard(eff([]));
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) =>
      key === RESOLVE_PERMISSIONS_KEY ? true : undefined,
    );
    const ctx = {
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    // "Resolve but do not enforce" is not "no authorization" — a session is still required.
    return expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('the controller forwards what users needs, and nothing it does not', () => {
  function makeController(createUpload: jest.Mock) {
    const client = { getService: () => ({ createUpload }) } as unknown as ClientGrpc;
    const ctrl = new UploadsController(client);
    ctrl.onModuleInit();
    return ctrl;
  }

  const req = { claims: CLAIMS, effective: eff(['crm.conversation.reply']) } as never;

  const file = {
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    mimetype: 'image/png',
    originalname: 'shot.png',
  } as Express.Multer.File;

  it('passes the declared type and filename through for users to judge', async () => {
    const createUpload = jest.fn(() => of({ id: 'up-1' }));
    const res = await makeController(createUpload).create('message_attachment', file, req);
    expect(res).toEqual({ id: 'up-1' });
    const [payload] = createUpload.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(payload.purpose).toBe('message_attachment');
    // Forwarded so `users` can COMPARE them against the content and then discard them. The gateway
    // makes no validation decision of its own (research R2).
    expect(payload.declaredContentType).toBe('image/png');
    expect(payload.filename).toBe('shot.png');
  });

  it('refuses a request with no file rather than calling users with nothing', async () => {
    const createUpload = jest.fn(() => of({ id: 'up-1' }));
    await expect(
      makeController(createUpload).create('message_attachment', undefined, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it('refuses a zero-byte file', async () => {
    const createUpload = jest.fn(() => of({ id: 'up-1' }));
    const empty = { ...file, buffer: Buffer.alloc(0) } as Express.Multer.File;
    await expect(
      makeController(createUpload).create('message_attachment', empty, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createUpload).not.toHaveBeenCalled();
  });

  it('*** a downstream NOT_FOUND surfaces as 404, never a 500 with a stack ***', async () => {
    // The defect feature 012's Track B found, pre-empted: Track-A specs mock ClientGrpc with `of()`
    // and never exercise the error path, so this one exercises it deliberately.
    const createUpload = jest.fn(() => throwError(() => ({ code: 5, details: 'internal detail' })));
    await expect(
      makeController(createUpload).create('message_attachment', file, req),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a refusal from users surfaces as 400 and carries no downstream detail', async () => {
    const createUpload = jest.fn(() =>
      throwError(() => ({ code: 3, details: 'john_smith_passport.png too_large' })),
    );
    try {
      await makeController(createUpload).create('message_attachment', file, req);
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as { status?: number; message?: string };
      expect(e.status).toBe(400);
      // The downstream string could carry a filename; a filename can itself be PII (FR-020).
      expect(JSON.stringify(e)).not.toContain('john_smith_passport');
    }
  });
});
