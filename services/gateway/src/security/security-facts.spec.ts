import { Reflector } from '@nestjs/core';
import { of, throwError } from 'rxjs';
import { SecurityFactsController } from './security-facts.controller';
import { REQUIRED_PERMISSION_KEY } from './requires-permission.decorator';

/**
 * ⭐ W32 (roadmap 12.11) — the posture page's edge.
 *
 * Two properties matter here and the rest is concatenation. First: the page is refused server-side,
 * because a page that lists what is and is not protected is a map for somebody who should not have
 * one. Second, and this is the one worth the file: **a service that cannot be reached contributes
 * `unknown`, never silence and never `ok`.**
 *
 * Silence would make a partial outage look like a shorter checklist — every remaining row green,
 * nothing to notice. `ok` would be worse: an administrator reading «healthy» about a control nobody
 * could verify, and acting on it.
 */

const fact = (key: string) => ({
  key,
  label: key,
  severity: 'informational',
  kind: 'read',
  state: 'ok',
  value: '1',
});

function harness(opts: { auth?: unknown; chats?: unknown } = {}) {
  const svc = (answer: unknown) => ({ listSecurityFacts: () => answer });
  const ctrl = new SecurityFactsController(
    { getService: () => svc(opts.auth ?? of({ facts: [fact('auth.keys.active')] })) } as never,
    { getService: () => svc(opts.chats ?? of({ facts: [fact('chats.channels')] })) } as never,
  );
  ctrl.onModuleInit();
  return ctrl;
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u-1', roles: ['admin'] },
    effective: { permissionKeys: ['platform.settings.manage'], roleKey: 'admin' },
  }) as never;

describe('*** the page is refused server-side, whatever the interface renders ***', () => {
  it('requires platform.settings.manage', () => {
    const key = new Reflector().get<string>(
      REQUIRED_PERMISSION_KEY,
      SecurityFactsController.prototype.facts,
    );
    expect(key).toBe('platform.settings.manage');
  });
});

describe('facts are concatenated from their owners', () => {
  it('returns both sources and a generation time', async () => {
    const out = (await harness().facts(req())) as { facts: { key: string }[]; generatedAt: string };
    expect(out.facts.map((f) => f.key)).toEqual(['auth.keys.active', 'chats.channels']);
    expect(out.generatedAt).toMatch(/^\d{4}-/);
  });
});

describe('*** ⭐ an unreachable service is UNKNOWN — never silent, never ok ***', () => {
  it('contributes a row when chats cannot answer', async () => {
    const out = (await harness({ chats: throwError(() => new Error('unavailable')) }).facts(
      req(),
    )) as { facts: { key: string; state: string; severity: string }[] };

    // The auth facts still arrive — one source failing does not empty the page.
    expect(out.facts.map((f) => f.key)).toContain('auth.keys.active');
    const gap = out.facts.find((f) => f.key === 'chats.unavailable');
    expect(gap).toBeDefined();
    // ⚠️ The two assertions that carry this file: it is UNKNOWN, and it is loud.
    expect(gap!.state).toBe('unknown');
    expect(gap!.state).not.toBe('ok');
    expect(gap!.severity).toBe('critical');
  });

  it('*** both failing still yields two rows, not an empty page ***', async () => {
    const out = (await harness({
      auth: throwError(() => new Error('unavailable')),
      chats: throwError(() => new Error('unavailable')),
    }).facts(req())) as { facts: { state: string }[] };

    // An empty page reads as «nothing to report». Two unknowns read as «we could not check», which
    // is the truth and is actionable.
    expect(out.facts).toHaveLength(2);
    expect(out.facts.every((f) => f.state === 'unknown')).toBe(true);
  });
});
