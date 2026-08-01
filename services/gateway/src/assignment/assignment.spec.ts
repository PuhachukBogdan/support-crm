import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { stripComments } from '@crm/common';
import { AssignmentController } from './assignment.controller';
import { AssignmentEdgeModule } from './assignment.module';

/**
 * T016 (feature 026, roadmap 5.7) — the assignment edge.
 *
 * ⚠️ Statuses are compared by NAME, not by tag, and the fakes below return names on purpose.
 * `grpcClientOptions` loads protos with `enums: String`, so the real service answers
 * `"ASSIGNMENT_STATUS_ALREADY_ASSIGNED"` and not `6`. Feature 025 lost a live iteration to exactly
 * this — writes kept working while reads broke, so every unit test stayed green because the fakes
 * echoed numbers. These fakes echo what the wire actually carries.
 */

const req = {
  claims: { userId: 'u-1', accountId: 'acc-1', roles: ['am'] },
  effective: { roleKey: 'am', permissionKeys: ['users.player.assign', 'crm.contact.view'] },
} as never;

const ASSIGNMENT = {
  brandId: 'brand-a',
  playerId: 'ply-1',
  amAuthUserId: 'am-1',
  assignedBy: 'lead-1',
  startedAt: '2026-08-02T10:00:00.000Z',
  endedAt: '',
};

function build(overrides: Record<string, unknown> = {}) {
  const writes = {
    assignPlayer: jest.fn(() => of({ status: 'ASSIGNMENT_STATUS_OK', assignment: ASSIGNMENT })),
    unassignPlayer: jest.fn(() => of({ status: 'ASSIGNMENT_STATUS_OK', assignment: ASSIGNMENT })),
    ...overrides,
  };
  const reads = {
    getPlayerAssignment: jest.fn(() => of(ASSIGNMENT)),
    listAssignedPlayers: jest.fn(() => of({ assignments: [ASSIGNMENT], nextPageToken: 'tok' })),
  };
  const controller = new AssignmentController({
    getService: (name: string) => (name === 'UsersReadService' ? reads : writes),
  } as never);
  controller.onModuleInit();
  return { controller, writes, reads };
}

describe('AssignmentController — proxying and status mapping', () => {
  it('⭐ every downstream call carries the ACTOR CONTEXT', async () => {
    // The live defect feature 025 found on its sibling: the first draft passed no metadata at all.
    // It compiled, every unit test passed, and on the real stack the service had no idea who was
    // asking — a fake client does not care what it is handed.
    const { controller, writes, reads } = build();
    await controller.assign(req, 'brand-a', 'ply-1', {});
    await controller.whoLooksAfter(req, 'brand-a', 'ply-1');

    for (const call of [writes.assignPlayer, reads.getPlayerAssignment]) {
      const md = (call as jest.Mock).mock.calls[0]![1];
      expect(md.get('x-actor-user-id')[0]).toBe('u-1');
      expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    }
  });

  it('an absent manager in the body means ME — self-assignment is the default shape', async () => {
    const { controller, writes } = build();
    await controller.assign(req, 'brand-a', 'ply-1', {});
    expect(writes.assignPlayer).toHaveBeenCalledWith(
      { brandId: 'brand-a', playerId: 'ply-1', amAuthUserId: '' },
      expect.anything(),
    );
  });

  it('⭐ ALREADY_ASSIGNED is 409, not a flat 400', async () => {
    // The request was well-formed; the STATE said no. A 400 would send the caller looking at their
    // own payload for a problem that is not there.
    const { controller } = build({
      assignPlayer: jest.fn(() => of({ status: 'ASSIGNMENT_STATUS_ALREADY_ASSIGNED', assignment: ASSIGNMENT })),
    });
    await expect(controller.assign(req, 'brand-a', 'ply-1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('⭐ a missing PLAYER and a missing MANAGER are two different 404s', async () => {
    // Collapsing them would send an administrator hunting for a player id when the real problem is
    // that the colleague they named has left the company.
    for (const [status, message] of [
      ['ASSIGNMENT_STATUS_NO_SUCH_PLAYER', 'no such player'],
      ['ASSIGNMENT_STATUS_NO_SUCH_MANAGER', 'no such manager'],
    ] as const) {
      const { controller } = build({ assignPlayer: jest.fn(() => of({ status })) });
      await expect(controller.assign(req, 'brand-a', 'ply-1', {})).rejects.toMatchObject({
        message: expect.stringContaining(message),
      });
    }
  });

  it('a refusal from the service is a 403, not a 500', async () => {
    const { controller } = build({ assignPlayer: jest.fn(() => of({ status: 'ASSIGNMENT_STATUS_FORBIDDEN' })) });
    await expect(controller.assign(req, 'brand-a', 'ply-1', {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('surfaces `changed: false` for a no-op rather than swallowing it', async () => {
    const { controller } = build({
      unassignPlayer: jest.fn(() => of({ status: 'ASSIGNMENT_STATUS_UNCHANGED' })),
    });
    const res = await controller.unassign(req, 'brand-a', 'ply-1');
    expect(res.changed).toBe(false);
  });

  it('⭐ "nobody looks after this player" is null, NOT a 404', async () => {
    // A 404 here would say "no such player", which is a different fact and would send somebody
    // hunting for a record that exists perfectly well and simply has no manager.
    const { controller } = build();
    const reads = build();
    reads.reads.getPlayerAssignment = jest.fn(() => of({})) as never;
    const ctl = new AssignmentController({
      getService: (n: string) => (n === 'UsersReadService' ? { getPlayerAssignment: () => of({}), listAssignedPlayers: () => of({}) } : {}),
    } as never);
    ctl.onModuleInit();
    expect((await ctl.whoLooksAfter(req, 'brand-a', 'ply-1')).assignment).toBeNull();
    expect(controller).toBeDefined();
  });

  it('a negative page size is refused rather than silently clamped at the edge', async () => {
    const { controller } = build();
    await expect(controller.myPlayers(req, '-3')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a session is required on every route', async () => {
    const { controller } = build();
    await expect(controller.myPlayers({} as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('the portfolio list passes the cursor through and returns the next one', async () => {
    const { controller, reads } = build();
    const res = await controller.myPlayers(req, '25', 'prev-token');
    expect(reads.listAssignedPlayers).toHaveBeenCalledWith(
      { amAuthUserId: '', pageSize: 25, pageToken: 'prev-token' },
      expect.anything(),
    );
    expect(res.nextPageToken).toBe('tok');
  });
});

describe('⭐ the assignment edge caches NOTHING', () => {
  const SRC = resolve(__dirname, 'assignment.controller.ts');

  it('no cache is imported, injected or referenced', () => {
    // Structural, because a cache here would pass every behavioural test above: the fakes answer
    // instantly and a TTL never elapses in a unit test. And the stake is higher than freshness — an
    // attachment decides what somebody may READ.
    const code = stripComments(readFileSync(SRC, 'utf8'));
    for (const banned of ['EffectivePermsCache', 'CacheInterceptor', 'CacheKey', 'CacheTTL', 'cacheManager']) {
      expect(code).not.toContain(banned);
    }
  });

  it('the module registers no cache module either', () => {
    const imports = (Reflect.getMetadata('imports', AssignmentEdgeModule) ?? []) as unknown[];
    expect(imports.map((m) => (m as { name?: string })?.name ?? String(m)).join(',')).not.toMatch(/Cache/i);
  });

  it('the reason is written at the site, not only in a spec', () => {
    // A guard whose reason lives only in the test is a guard the next person deletes as noise.
    const raw = readFileSync(SRC, 'utf8');
    expect(raw).toMatch(/access-control defect/i);
  });
});
