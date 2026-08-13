import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AuthController } from './auth.controller';
import { HealthController } from '../health/health.controller';
import { PingController } from '../ping/ping.controller';

/**
 * T023 (US2) — the `@Public()` allow-list is CLOSED to exactly the infra probes, the auth-entry
 * endpoints and the two machine intakes. Every other surface (e.g. `/auth/me`) is guarded.
 *
 * ── ⚠️ Why this gained a SCAN in W31, and what that fixed ────────────────────────────────────────
 * It used to assert only about the controllers it imported, so it could not see a public route in a
 * file it did not name — and it could not: the channel intake had been `@Public()` since feature 029
 * and this spec had never heard of it. An allow-list that only lists what somebody remembered to add
 * is not an allow-list. The scan below reads every `@Public()` in the gateway's source, so a new one
 * fails this test until it is written down here with a reason. The reflection assertions stay: they
 * check the decorator actually took effect, which text cannot.
 */
const GATEWAY_SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/**
 * Every `@Public()` in the gateway, as `file -> the handler or class it decorates`.
 *
 * The NAME only, never the signature: a list keyed on parameter text would go red on a formatting
 * change, and a guard that cries wolf gets its expectations pasted over rather than read.
 */
function publicSurfaces(): string[] {
  const found: string[] = [];
  for (const file of walk(GATEWAY_SRC)) {
    const rel = file.slice(GATEWAY_SRC.length + 1).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*@Public\(\)/.test(line)) return;
      // The next line that is not a decorator, a comment or blank IS what it decorates.
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]!.trim();
        if (
          next === '' ||
          next.startsWith('@') ||
          next.startsWith('//') ||
          next.startsWith('*') ||
          next.startsWith('/*')
        ) {
          continue;
        }
        const named = /(?:async\s+)?(\w+)\s*\(/.exec(next) ?? /class\s+(\w+)/.exec(next);
        found.push(`${rel} -> ${named ? named[1] : next.slice(0, 40)}`);
        break;
      }
    });
  }
  return found.sort();
}

describe('@Public() allow-list is closed (feature 009)', () => {
  const reflector = new Reflector();
  type MetaTarget = Parameters<Reflector['get']>[1];
  const isPublic = (target: MetaTarget) => reflector.get<boolean>(IS_PUBLIC_KEY, target) === true;

  it('*** ⭐ the complete set of unauthenticated surfaces, and nothing else ***', () => {
    expect(publicSurfaces()).toEqual([
      // The auth-entry endpoints: reachable before a session exists, by definition.
      'auth/auth.controller.ts -> login',
      'auth/auth.controller.ts -> refresh',
      'auth/auth.controller.ts -> verify',
      // The invited colleague binding their email and choosing a password. Public for the same
      // reason as login — the session they are about to have does not exist yet. Their protection is
      // the single-use token in the link, checked by auth.
      'auth/onboarding.controller.ts -> complete',
      'auth/onboarding.controller.ts -> request',
      'auth/registration.controller.ts -> complete',
      'auth/registration.controller.ts -> start',
      // Feature 029: the channel intake. Public since it was built and never listed here until W31 —
      // the gap that turned this spec into a scan. Its authentication is an HMAC signature over the
      // raw body, verified by chats, which is why no session is possible or wanted.
      'channels/channels.controller.ts -> inbound',
      // Infra probes: they answer before the product is up, so a session check would defeat them.
      'health/health.controller.ts -> HealthController',
      'ping/ping.controller.ts -> PingController',
      // ⭐ W31 / feature 038: the staff-provisioning namespace. Same shape as the channel intake and
      // for the same reason — the caller is another company's system holding a key, and the
      // authentication travels in the signature. Listed per METHOD, never on the class: a class-level
      // `@Public()` here would silently exempt whatever route somebody adds to it next.
      'provisioning/provisioning.controller.ts -> createStaff',
      'provisioning/provisioning.controller.ts -> offboardStaff',
    ]);
  });

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

  it('*** the provisioning CLASS is not public, only its two machine routes ***', async () => {
    const { ProvisioningController } = await import('../provisioning/provisioning.controller');
    expect(isPublic(ProvisioningController)).toBe(false);
    expect(isPublic(ProvisioningController.prototype.createStaff)).toBe(true);
    expect(isPublic(ProvisioningController.prototype.offboardStaff)).toBe(true);
  });
});
