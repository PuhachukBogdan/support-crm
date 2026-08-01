import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { stripComments } from '@crm/common';
import { PresenceController } from './presence.controller';
import { PresenceEdgeModule } from './presence.module';

/**
 * T025 (feature 025, roadmap 5.9) — the presence edge.
 *
 * Two kinds of assertion here, and the second is the one that matters most:
 *
 *   1. **Proxying and status mapping.** Each outcome maps to its own HTTP answer; a REST client
 *      speaks state NAMES and never wire numbers.
 *   2. **⭐ There is NO cache.** Structural, because the failure it prevents is invisible in a unit
 *      test: a stale "available" pushes a LIVE customer at somebody who has gone home. The
 *      permissions cache next door (30 s + explicit invalidation) is the precedent *and* the
 *      warning — it works only because every privilege change invalidates it, and presence changes
 *      far more often than privileges do, including from a SWEEP no edge can observe.
 */

const STATUS = { OK: 1, UNCHANGED: 2, FORBIDDEN: 3, NO_SUCH_OPERATOR: 4, UNKNOWN_LABEL: 5, NAME_TAKEN: 6 };

// ⚠️ `effective` too, not just `claims`. `buildActorMetadata` reads both, and the live run proved
// what happens when the actor context does not reach `users`: a presence read for somebody who was
// online answered `offline`, because the service had no idea who was asking.
const req = {
  // `userId`, not `sub` — the field `buildActorMetadata` actually reads. A fixture that names it
  // wrongly produces an EMPTY `x-actor-user-id`, which is precisely the live failure this test is
  // here to prevent, arriving through the test's own data instead of through the product.
  claims: { userId: 'u-1', accountId: 'acc-1', roles: ['admin'] },
  effective: { roleKey: 'admin', permissionKeys: ['users.list.view', 'users.presence.manage'] },
} as never;

function build(overrides: Record<string, unknown> = {}) {
  const presence = {
    setOwnPresence: jest.fn(() => of({ status: STATUS.OK, presence: { authUserId: 'u-1', state: 1 } })),
    heartbeat: jest.fn(() => of({ status: STATUS.UNCHANGED, presence: { authUserId: 'u-1', state: 3 } })),
    setChannelAvailability: jest.fn(() => of({ status: STATUS.OK, presence: { authUserId: 'u-1', state: 1 } })),
    setOperatorPresence: jest.fn(() => of({ status: STATUS.OK, presence: { authUserId: 'u-2', state: 4 } })),
    listPresenceLabels: jest.fn(() => of({ labels: [{ id: 'l-1', name: 'Lunch', state: 3 }] })),
    upsertPresenceLabel: jest.fn(() => of({ status: STATUS.OK, label: { id: 'l-1', name: 'Lunch', state: 3 } })),
    deletePresenceLabel: jest.fn(() => of({ status: STATUS.OK })),
    ...overrides,
  };
  const read = {
    getOperatorPresence: jest.fn(() =>
      of({ authUserId: 'u-1', state: 2, lastCause: 2, lastSeenAt: '2026-08-01T10:00:00.000Z', blockedChannels: ['email'], operatorActive: true }),
    ),
    listOperatorPresence: jest.fn(() => of({ presence: [{ authUserId: 'u-1', state: 1 }] })),
  };
  const controller = new PresenceController({
    getService: (name: string) => (name === 'UsersReadService' ? read : presence),
  } as never);
  controller.onModuleInit();
  return { controller, presence, read };
}

describe('PresenceController — proxying and status mapping', () => {
  it('a REST client sees state NAMES, never wire numbers', () => {
    // A number in a JSON body makes every client carry a copy of the proto's numbering, and copies
    // drift. The edge is where the wire stops.
    return build()
      .controller.getMine(req)
      .then((res) => {
        expect(res).toMatchObject({
          state: 'transfers_only',
          lastCause: 'auto_inactivity',
          blockedChannels: ['email'],
          operatorActive: true,
        });
      });
  });

  it('⭐ surfaces `changed: false` for a no-op instead of swallowing it', async () => {
    // FR-015 makes the difference observable on purpose: one path writes exactly one history record
    // and the other must write none. A client that asked for a change and got none should be able
    // to tell — collapsing both into 200 is how "exactly one event" becomes untestable from outside.
    const { controller } = build();
    const res = await controller.heartbeat(req);
    expect(res.changed).toBe(false);
  });

  it('an unknown state NAME is refused, never defaulted', async () => {
    // ⚠️ Fail-closed. A state that fell through to `online` would WIDEN availability, and the
    // widening direction is the one that pushes live customers at absent agents.
    const { controller, presence } = build();
    await expect(controller.setMine(req, { state: 'busy' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.setMine(req, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(presence.setOwnPresence).not.toHaveBeenCalled();
  });

  it('a channel switch requires an explicit boolean', async () => {
    const { controller } = build();
    await expect(controller.setChannel(req, 'email', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.setChannel(req, '  ', { available: false })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('⚠️ but does NOT validate the channel against a vocabulary', async () => {
    // This product has no channel vocabulary yet (roadmap 4.17 / Phase 6 own it), and inventing one
    // here would force a reconciliation later. A key nobody routes to switches off a channel nobody
    // routes to — harmless by construction (research R8).
    const { controller, presence } = build();
    await controller.setChannel(req, 'carrier-pigeon', { available: false });
    expect(presence.setChannelAvailability).toHaveBeenCalledWith(
      { channel: 'carrier-pigeon', available: false },
      expect.anything(),
    );
  });

  it.each([
    [STATUS.FORBIDDEN, ForbiddenException],
    [STATUS.NO_SUCH_OPERATOR, NotFoundException],
  ])('maps status %p to its own HTTP answer', async (status, error) => {
    const { controller } = build({
      setOwnPresence: jest.fn(() => of({ status })),
    });
    await expect(controller.setMine(req, { state: 'online' })).rejects.toBeInstanceOf(error);
  });

  it('a duplicate label name is 422, not a flat 400', async () => {
    const { controller } = build({
      upsertPresenceLabel: jest.fn(() => of({ status: STATUS.NAME_TAKEN })),
    });
    await expect(
      controller.upsertLabel(req, { name: 'Lunch', state: 'away' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('⭐ every downstream call carries the ACTOR CONTEXT (found live, not offline)', async () => {
    // The first draft passed no metadata at all. It compiled, and every test in this file passed,
    // because a fake client does not care. On the live stack `users` received no account and no user.
    const { controller, presence, read } = build();
    await controller.getMine(req);
    await controller.heartbeat(req);
    await controller.setMine(req, { state: 'online' });

    for (const call of [read.getOperatorPresence, presence.heartbeat, presence.setOwnPresence]) {
      const md = (call as jest.Mock).mock.calls[0]![1];
      expect(md).toBeDefined();
      expect(md.get('x-actor-user-id')[0]).toBe('u-1');
      expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    }
  });

  it('a session is required everywhere, including the unkeyed self-service routes', async () => {
    const { controller } = build();
    await expect(controller.getMine({} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('listing presence without operator ids is refused rather than answered broadly', async () => {
    // An unbounded list would be a staff directory by accident, and this edge is gated on
    // `users.list.view` precisely because that is what it is.
    const { controller } = build();
    await expect(controller.listPresence(req, '')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('⭐ the presence edge caches NOTHING (FR-032)', () => {
  const SRC = resolve(__dirname, 'presence.controller.ts');

  it('no cache is imported, injected or referenced in the controller', () => {
    // Structural, because a cache added here would pass every behavioural test in this file: the
    // fakes answer instantly and a TTL never elapses inside a unit test. Only the absence is testable.
    const code = stripComments(readFileSync(SRC, 'utf8'));
    for (const banned of ['EffectivePermsCache', 'CacheInterceptor', 'CacheKey', 'CacheTTL', 'cacheManager']) {
      expect(code).not.toContain(banned);
    }
  });

  it('the module does not register a cache module either', () => {
    const imports = (Reflect.getMetadata('imports', PresenceEdgeModule) ?? []) as unknown[];
    const names = imports.map((m) => (m as { name?: string })?.name ?? String(m));
    expect(names.join(',')).not.toMatch(/Cache/i);
  });

  it('the reason is written down at the site, not only in a spec', () => {
    // A guard whose reason lives only in the test is a guard the next person deletes as noise. The
    // comment is the artefact under test here, so the file is read UNSTRIPPED.
    const raw = readFileSync(SRC, 'utf8');
    expect(raw).toMatch(/FR-032/);
    expect(raw).toMatch(/stale "available"|gone home/i);
  });
});
