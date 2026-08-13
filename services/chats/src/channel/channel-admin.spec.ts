import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { ChannelRepository } from './channel.repository';
import { ChannelAdminController } from './channel-admin.grpc.controller';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';

/**
 * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the channels admin surface. **THE BLOCK'S INVARIANT
 * IS SERVER-SIDE RBAC**: channel configuration decides which tenant and brand an arriving delivery
 * belongs to, so the write must be refused at THIS tier for anyone without
 * `platform.settings.manage` — a hidden button proves nothing about a crafted request.
 *
 * ── What this file deliberately does NOT assert ──────────────────────────────────────────────────
 * Which ROLES hold the key — that is auth's fact (admin + super_admin via ALL_KEYS, no operational
 * role), asserted where the catalogue lives. Here the permission set is a parameter, exactly as in
 * `brand-write-rule.spec.ts`.
 */

const EMAIL_ROW = {
  id: 'ch-email-1',
  account_id: 'acc-1',
  brand_id: 'brand-a',
  kind: 'email',
  key: 'stand-email-brand1',
  address: 'support-old@stand.test',
  default_group_id: null,
  enabled: true,
};
const API_ROW = {
  id: 'ch-api-1',
  account_id: 'acc-1',
  brand_id: 'brand-a',
  kind: 'api',
  key: 'stand-api-brand1',
  address: null,
  default_group_id: null,
  enabled: true,
};

function fakePrisma(initial: Array<Record<string, unknown>>) {
  const rows = initial.map((r) => ({ ...r }));
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const creates: Array<Record<string, unknown>> = [];
  const auditWrites: Array<Record<string, unknown>> = [];
  const batches: unknown[][] = [];

  const scoped = {
    channel: {
      findMany: async () => rows.map((r) => ({ ...r })),
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        const hit = rows.find((r) => r.id === args.where.id);
        if (hit) Object.assign(hit, args.data);
        return { count: hit ? 1 : 0 };
      },
      create: (args: { data: Record<string, unknown> }) => {
        creates.push(args.data);
        rows.push({ account_id: 'acc-1', default_group_id: null, enabled: true, ...args.data });
        return {};
      },
    },
    auditEntry: {
      create: (args: { data: Record<string, unknown> }) => {
        auditWrites.push(args.data);
        return {};
      },
    },
    $transaction: async (statements: unknown[]) => {
      batches.push(statements);
      return statements.map((s) => s ?? {});
    },
  };

  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, rows, updates, creates, auditWrites, batches };
}

const build = (prisma: PrismaService) =>
  new ChannelAdminController(new ChannelRepository(prisma), new AuditRepository(prisma));

function md(permissions: string[], accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', permissions.join(','));
  return m;
}

/** A caller with everything a TEAMLEAD has — every supervisory capability, no tenant configuration.
 *  That is what makes the refusal about THIS key rather than about a caller who could do nothing. */
const TEAMLEAD_PERMS = [
  'crm.inbox.view',
  'crm.conversation.reply',
  'crm.conversation.assign',
  'crm.conversation.set_brand',
  'crm.labels.manage',
  'crm.templates.manage',
  'users.list.view',
  'platform.group.manage',
];
const ADMIN_PERMS = [...TEAMLEAD_PERMS, 'platform.settings.manage'];

describe('*** channel configuration is refused below `platform.settings.manage` (server-side) ***', () => {
  const guardCtx = (handler: unknown, perms: string[]) =>
    ({
      getType: () => 'rpc',
      getHandler: () => handler,
      getClass: () => ChannelAdminController,
      switchToRpc: () => ({ getContext: () => md(perms) }),
    }) as never;

  it('⭐ the guard refuses BOTH handlers for a teamlead-shaped permission set', () => {
    const guard = new ChatsAccessGuard(new Reflector());
    expect(() =>
      guard.canActivate(guardCtx(ChannelAdminController.prototype.listChannels, TEAMLEAD_PERMS)),
    ).toThrow(RpcException);
    expect(() =>
      guard.canActivate(guardCtx(ChannelAdminController.prototype.upsertEmailChannel, TEAMLEAD_PERMS)),
    ).toThrow(RpcException);
  });

  it('⭐ POSITIVE CONTROL: the same guard admits the configuration key', () => {
    const guard = new ChatsAccessGuard(new Reflector());
    expect(guard.canActivate(guardCtx(ChannelAdminController.prototype.listChannels, ADMIN_PERMS))).toBe(true);
    expect(guard.canActivate(guardCtx(ChannelAdminController.prototype.upsertEmailChannel, ADMIN_PERMS))).toBe(true);
  });

  it('both handlers declare `platform.settings.manage` — tenant configuration, not a new key', () => {
    const reflector = new Reflector();
    for (const h of [
      ChannelAdminController.prototype.listChannels,
      ChannelAdminController.prototype.upsertEmailChannel,
    ]) {
      expect(reflector.get<string>(REQUIRED_CHATS_PERMISSION_KEY, h)).toBe('platform.settings.manage');
    }
  });
});

describe('the admin read', () => {
  it('lists the configured channels with key, address and enabled', async () => {
    const { prisma } = fakePrisma([EMAIL_ROW, API_ROW]);
    const res = await build(prisma).listChannels({}, md(ADMIN_PERMS));
    expect(res.channels).toHaveLength(2);
    const api = res.channels.find((c: { kind: string }) => c.kind === 'api')!;
    expect(api.key).toBe('stand-api-brand1');
    expect(api.address).toBe('');
    expect(api.enabled).toBe(true);
  });

  it('⛔ the wire carries EXACTLY six fields — no place a secret could ride', async () => {
    // The Channel table holds no secret (it lives in CHANNEL_SECRETS configuration), so this is a
    // claim about the mapping staying that way: a `secret`/`token` field added to the wire would
    // fail here by existing.
    const { prisma } = fakePrisma([API_ROW]);
    const res = await build(prisma).listChannels({}, md(ADMIN_PERMS));
    expect(Object.keys(res.channels[0]!).sort()).toEqual(
      ['id', 'brandId', 'kind', 'key', 'address', 'enabled'].sort(),
    );
  });
});

describe('the one write: a brand’s mail address', () => {
  it('⭐ changes an existing email channel’s address and files ONE audit entry, in ONE transaction', async () => {
    const { prisma, updates, auditWrites, batches } = fakePrisma([EMAIL_ROW, API_ROW]);

    const res = await build(prisma).upsertEmailChannel(
      { brandId: 'brand-a', address: 'support-new@stand.test' },
      md(ADMIN_PERMS),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toEqual({ address: 'support-new@stand.test' });
    expect(res.address).toBe('support-new@stand.test');
    expect(res.key).toBe('stand-email-brand1'); // the key never moves on an address change

    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      action: 'channel.config_changed',
      actor_kind: 'user',
      actor_user_id: 'u-admin',
      target_ref: 'ch-email-1',
      // Refs and the kind — never the address (the detail layer would refuse the `@` anyway).
      detail_json: { brandRef: 'brand-a', channelKind: 'email' },
    });
    expect(JSON.stringify(auditWrites[0])).not.toContain('support-new');
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('⭐ a brand with no email channel gets one: generated `em-` key, the address, one audit entry', async () => {
    const { prisma, creates, auditWrites } = fakePrisma([API_ROW]);

    const res = await build(prisma).upsertEmailChannel(
      { brandId: 'brand-a', address: 'support@stand.test' },
      md(ADMIN_PERMS),
    );

    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ brand_id: 'brand-a', kind: 'email', address: 'support@stand.test' });
    expect(String(creates[0]!.key)).toMatch(/^em-[0-9a-f]{12}$/);
    expect(res.kind).toBe('email');
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]!.target_ref).toBe(res.id); // the id was decided before the write
  });

  it('refuses a no-op — the address it already has writes nothing, exactly like setBrand', async () => {
    const { prisma, updates, auditWrites } = fakePrisma([EMAIL_ROW]);
    await expect(
      build(prisma).upsertEmailChannel(
        { brandId: 'brand-a', address: 'support-old@stand.test' },
        md(ADMIN_PERMS),
      ),
    ).rejects.toThrow(RpcException);
    expect(updates).toHaveLength(0);
    expect(auditWrites).toHaveLength(0);
  });

  it.each(['', 'no-at-sign', 'two words@x.test', `a@${'b'.repeat(320)}`])(
    'refuses a non-address (%j) before anything is read or written',
    async (address) => {
      const { prisma, updates, creates } = fakePrisma([EMAIL_ROW]);
      await expect(
        build(prisma).upsertEmailChannel({ brandId: 'brand-a', address }, md(ADMIN_PERMS)),
      ).rejects.toThrow(RpcException);
      expect(updates).toHaveLength(0);
      expect(creates).toHaveLength(0);
    },
  );
});
