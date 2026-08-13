import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import type { DomainEventPublisher } from '../events/events.publisher';
import { AuditRepository } from '../audit/audit.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';
import { fakeStatusRepository } from '../status/status.fixture';

/**
 * ⭐ T021 (feature 032, roadmap 4.16 — R22, amends ADR 0038). **THE BLOCK'S NAMED INVARIANT TEST**
 * (`mvp-plan.md` Appendix В): *an agent cannot change a conversation's brand.*
 *
 * ── Why this one is singled out ──────────────────────────────────────────────────────────────────
 * Brand is auto-assigned at ingestion and decides which reports a conversation appears in and whose
 * history it becomes part of. Everything else on the write controller is an everyday act by whoever
 * handles the ticket; this is the one field the operator's rule places out of an agent's reach. A rule
 * like that is either enforced on the SERVER or it is a disabled button.
 *
 * ── Both halves, and the positive control ────────────────────────────────────────────────────────
 * *"An agent cannot"* is satisfied by a broken handler, so the supervisor's success is asserted in the
 * same file — with the audit entry, which is the other half of R22.
 *
 * ── ⚠️ What this file deliberately does NOT assert ───────────────────────────────────────────────
 * **Which ROLES hold the key.** That is auth's fact, and importing auth's catalogue into a chats spec
 * would cross the boundary Principle VIII draws — in a test, but in the same direction the product is
 * forbidden to go. It is asserted in `tests/statuses/brand-write-rule-roles.spec.ts`, at the tier that
 * legitimately sees both services. Here the permission set is a PARAMETER: this service's job is to
 * refuse a caller without the key and admit one with it, whoever that turns out to be.
 */

const CONV = {
  id: 'c1',
  account_id: 'acc-1',
  brand_id: 'brand-a',
  player_id: 'p1',
  status: 'open',
  status_def: { category: 'open' },
  priority: 'normal',
  assignee_operator_id: 'op-1',
  channel: 'api',
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  subject: 'Promo code not applying at checkout',
  subject_source: 'manual',
  routed_group_id: null,
  created_at: new Date('2026-08-04T10:00:00.000Z'),
  updated_at: new Date('2026-08-04T10:00:00.000Z'),
};

function fakePrisma(exists = true) {
  const row = { ...CONV };
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const auditWrites: Array<Record<string, unknown>> = [];
  /** Every statement handed to `$transaction`, so "one transaction" is a fact rather than a hope. */
  const batches: unknown[][] = [];

  const scoped = {
    conversation: {
      findFirst: async () => (exists ? { ...row } : null),
      updateMany: (args: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        Object.assign(row, args.data);
        return { __stmt: 'conversation.updateMany', count: exists ? 1 : 0 };
      },
    },
    auditEntry: {
      create: (args: { data: Record<string, unknown> }) => {
        auditWrites.push(args.data);
        return { __stmt: 'auditEntry.create' };
      },
    },
    $transaction: async (statements: unknown[]) => {
      batches.push(statements);
      return [{ count: exists ? 1 : 0 }, {}];
    },
  };

  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, row, updates, auditWrites, batches };
}

const noEvents = () =>
  ({
    conversationCreated: jest.fn(async () => 0),
    statusChanged: jest.fn(async () => 0),
  }) as unknown as DomainEventPublisher;

const build = (prisma: PrismaService) =>
  new ConversationWriteController(
    new ConversationRepository(prisma, new TransitionRecorder()),
    noEvents(),
    fakeStatusRepository(),
    new AuditRepository(prisma),
  );

function md(permissions: string[], accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-super');
  m.set('x-actor-permissions', permissions.join(','));
  return m;
}

/**
 * A caller who can do everything an agent can do on a conversation — and does NOT hold the brand key.
 *
 * ⚠️ Deliberately EVERY other conversation permission: that is what makes the refusal below about this
 * capability rather than about a caller who could not have done anything anyway.
 */
const AGENT_PERMS = [
  'crm.inbox.view',
  'crm.conversation.reply',
  'crm.conversation.assign',
  'crm.labels.manage',
  'crm.macros.use',
  'crm.contact.view',
];
const SUPERVISOR_PERMS = [...AGENT_PERMS, 'crm.conversation.set_brand'];

// ── The rule, at the tier that enforces it ───────────────────────────────────────────────────────

describe('*** an AGENT cannot change a conversation’s brand (R22) ***', () => {
  it('⭐ the service-tier guard refuses the handler for an agent’s permission set', () => {
    // The guard is the enforcement point for a call that skips the gateway entirely (Principle II).
    const guard = new ChatsAccessGuard(new Reflector());
    const ctx = {
      getType: () => 'rpc',
      getHandler: () => ConversationWriteController.prototype.setConversationBrand,
      getClass: () => ConversationWriteController,
      switchToRpc: () => ({ getContext: () => md(AGENT_PERMS) }),
    } as never;

    expect(() => guard.canActivate(ctx)).toThrow(RpcException);
  });

  it('⭐ POSITIVE CONTROL: the same guard admits a SUPERVISOR — the refusal is about the role', () => {
    const guard = new ChatsAccessGuard(new Reflector());
    const ctx = {
      getType: () => 'rpc',
      getHandler: () => ConversationWriteController.prototype.setConversationBrand,
      getClass: () => ConversationWriteController,
      switchToRpc: () => ({ getContext: () => md(SUPERVISOR_PERMS) }),
    } as never;

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('the handler declares the key, and it is NOT the everyday reply key', () => {
    const declared = new Reflector().get<string>(
      REQUIRED_CHATS_PERMISSION_KEY,
      ConversationWriteController.prototype.setConversationBrand,
    );
    expect(declared).toBe('crm.conversation.set_brand');
    expect(declared).not.toBe('crm.conversation.reply');
  });

  it('⚠️ the refused caller holds EVERY other conversation permission — so the gap is this one key', () => {
    // Without this, the refusal above is satisfied by a caller who could not do anything at all, and the
    // test would keep passing if the handler were gated by something nobody holds.
    expect(AGENT_PERMS).toContain('crm.conversation.reply');
    expect(AGENT_PERMS).not.toContain('crm.conversation.set_brand');
    expect(SUPERVISOR_PERMS).toEqual([...AGENT_PERMS, 'crm.conversation.set_brand']);
  });
});

// ── The supervisor's write, and its trail ────────────────────────────────────────────────────────

describe('*** a SUPERVISOR’s change succeeds and writes exactly ONE audit entry ***', () => {
  it('⭐ updates the brand and files one `conversation.brand_changed` entry, in ONE transaction', async () => {
    const { prisma, updates, auditWrites, batches } = fakePrisma();

    const res = await build(prisma).setConversationBrand(
      { conversationId: 'c1', brandId: 'brand-b' },
      md(SUPERVISOR_PERMS),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toEqual({ brand_id: 'brand-b' });
    expect(res.brandId).toBe('brand-b');

    // Exactly one entry — not two, and not zero.
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]).toMatchObject({
      action: 'conversation.brand_changed',
      actor_kind: 'user',
      actor_user_id: 'u-super',
      target_ref: 'c1',
      detail_json: { fromBrandRef: 'brand-a', toBrandRef: 'brand-b' },
    });

    // ⚠️ The change and its record are in the SAME batch: either both land or neither does (FR-009).
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('⚠️ the entry carries REFS only — no brand NAME, and nothing that looks like a person', async () => {
    const { prisma, auditWrites } = fakePrisma();
    await build(prisma).setConversationBrand(
      { conversationId: 'c1', brandId: 'brand-b' },
      md(SUPERVISOR_PERMS),
    );
    const serialised = JSON.stringify(auditWrites[0]);
    expect(serialised).not.toMatch(/@/); // an email would be refused by the detail allow-list anyway
    expect(Object.keys(auditWrites[0]!.detail_json as object).sort()).toEqual([
      'fromBrandRef',
      'toBrandRef',
    ]);
  });

  it('refuses a NO-OP rather than filing an entry that records nothing', async () => {
    const { prisma, updates, auditWrites } = fakePrisma();
    await expect(
      build(prisma).setConversationBrand(
        { conversationId: 'c1', brandId: 'brand-a' },
        md(SUPERVISOR_PERMS),
      ),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });
    expect(updates).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it('refuses an empty brand, and writes nothing', async () => {
    const { prisma, updates, auditWrites } = fakePrisma();
    for (const brandId of ['', '   ', undefined]) {
      await expect(
        build(prisma).setConversationBrand({ conversationId: 'c1', brandId }, md(SUPERVISOR_PERMS)),
      ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });
    }
    expect(updates).toEqual([]);
    expect(auditWrites).toEqual([]);
  });

  it('a conversation outside the account is NOT_FOUND, with no entry and no existence disclosure', async () => {
    const { prisma, auditWrites } = fakePrisma(false);
    await expect(
      build(prisma).setConversationBrand(
        { conversationId: 'other', brandId: 'brand-b' },
        md(SUPERVISOR_PERMS),
      ),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.NOT_FOUND } });
    // ⚠️ A trail that records non-events is worse than one with a gap — a reader cannot tell them apart.
    expect(auditWrites).toEqual([]);
  });

  it('⭐ the write runs through the ACCOUNT-scoped client (Principle I)', async () => {
    const { prisma } = fakePrisma();
    await build(prisma).setConversationBrand(
      { conversationId: 'c1', brandId: 'brand-b' },
      md(SUPERVISOR_PERMS, 'acc-9'),
    );
    expect((prisma.forAccount as jest.Mock).mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['acc-9']),
    );
  });
});
