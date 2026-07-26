import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthController } from './auth.controller';
import { HealthController } from '../health/health.controller';
import { PingController } from '../ping/ping.controller';

/**
 * T023 (US2) — the `@Public()` allow-list is CLOSED to exactly the infra probes and the
 * auth-entry endpoints. Every other surface (e.g. `/auth/me`) is guarded. Reflecting the
 * metadata keeps the allow-list from silently growing (a new public route must be deliberate).
 */
describe('@Public() allow-list is closed (feature 009)', () => {
  const reflector = new Reflector();
  type MetaTarget = Parameters<Reflector['get']>[1];
  const isPublic = (target: MetaTarget) => reflector.get<boolean>(IS_PUBLIC_KEY, target) === true;

  it('the infra probes are public (unauthenticated by design)', () => {
    expect(isPublic(HealthController)).toBe(true);
    expect(isPublic(PingController)).toBe(true);
  });

  it('only the auth-ENTRY endpoints are public; the auth controller class is not', () => {
    expect(isPublic(AuthController)).toBe(false);
    expect(isPublic(AuthController.prototype.login)).toBe(true);
    expect(isPublic(AuthController.prototype.verify)).toBe(true);
    // Refresh must work once the access token has expired → public (verified by the refresh cookie).
    expect(isPublic(AuthController.prototype.refresh)).toBe(true);
  });

  it('session-bearing endpoints (/auth/me, /auth/logout) are NOT public', () => {
    expect(isPublic(AuthController.prototype.me)).toBe(false);
    expect(isPublic(AuthController.prototype.logout)).toBe(false);
  });
});
