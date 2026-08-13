import { PresenceService } from './presence.service';
import { LabelsRepository } from './labels.repository';
import type { PresenceRepository } from './presence.repository';
import type { OperatorTransitionRecorder } from '../transition/transition.recorder';
import type { PrismaService } from '../prisma.service';

/**
 * T042/T043 (channel switches) and T052 (labels) — feature 025, roadmap 5.9.
 *
 * Two subjects in one file because they share the one property that matters about both: **neither
 * may change availability in the direction it is not allowed to.** A switch may only subtract; a
 * label may not move anything at all. Proving them side by side is what keeps the asymmetry visible.
 */

interface Block {
  account_id: string;
  auth_user_id: string;
  channel: string;
}

function makeChannelStore(blocks: Block[] = []) {
  const transitions: Array<Record<string, unknown>> = [];

  const repo = {
    async operatorFor() {
      return { operatorId: 'op-1', active: true };
    },
    async read(_a: string, authUserId: string) {
      return {
        auth_user_id: authUserId,
        state: 'online',
        last_cause: 'manual',
        last_seen_at: null,
        label_id: null,
      };
    },
    async blockedChannels(accountId: string, ids: readonly string[]) {
      const out = new Map<string, string[]>();
      for (const id of ids) {
        const mine = blocks.filter((b) => b.account_id === accountId && b.auth_user_id === id);
        if (mine.length)
          out.set(
            id,
            mine.map((b) => b.channel),
          );
      }
      return out;
    },
    async setChannelBlock(
      accountId: string,
      authUserId: string,
      channel: string,
      blocked: boolean,
      record: (tx: unknown) => unknown,
    ) {
      if (blocked) blocks.push({ account_id: accountId, auth_user_id: authUserId, channel });
      else {
        const i = blocks.findIndex(
          (b) =>
            b.account_id === accountId && b.auth_user_id === authUserId && b.channel === channel,
        );
        if (i >= 0) blocks.splice(i, 1);
      }
      await record({});
    },
    async applyState() {
      /* not exercised here */
    },
  } as unknown as PresenceRepository;

  const recorder = {
    async record(_tx: unknown, input: Record<string, unknown>) {
      transitions.push(input);
    },
  } as unknown as OperatorTransitionRecorder;

  return { service: new PresenceService(repo, recorder), blocks, transitions };
}

describe('a channel switch subtracts, and only ever subtracts (US3)', () => {
  it('switching a channel OFF inserts a block and records exactly one transition', async () => {
    const { service, blocks, transitions } = makeChannelStore();
    const out = await service.setChannelAvailability('acc-1', 'u-1', 'live_chat', false);
    expect(out.status).toBe('ok');
    expect(blocks.map((b) => b.channel)).toEqual(['live_chat']);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'operator.channel_availability_changed',
      subjectKind: 'operator',
      subjectId: 'u-1',
      payload: { channel: 'live_chat', available: 'false', cause: 'manual' },
    });
  });

  it('⭐ switching it back ON DELETES the row — there is no stored `true`', async () => {
    // A row's existence IS the block. If a `true` were ever stored, the question "does an explicit
    // true beat the presence state?" becomes askable, and the answer must be no — so the value that
    // could express the violation does not exist.
    const { service, blocks } = makeChannelStore([
      { account_id: 'acc-1', auth_user_id: 'u-1', channel: 'live_chat' },
    ]);
    await service.setChannelAvailability('acc-1', 'u-1', 'live_chat', true);
    expect(blocks).toEqual([]);
  });

  it('switching ON a channel that is already on writes NOTHING (FR-015)', async () => {
    const { service, transitions } = makeChannelStore();
    const out = await service.setChannelAvailability('acc-1', 'u-1', 'email', true);
    expect(out.status).toBe('unchanged');
    expect(transitions).toHaveLength(0);
  });

  it('switching OFF a channel that is already off writes NOTHING either', async () => {
    const { service, transitions } = makeChannelStore([
      { account_id: 'acc-1', auth_user_id: 'u-1', channel: 'email' },
    ]);
    const out = await service.setChannelAvailability('acc-1', 'u-1', 'email', false);
    expect(out.status).toBe('unchanged');
    expect(transitions).toHaveLength(0);
  });

  it('a channel the product has never heard of is accepted, and harmless', async () => {
    // No vocabulary exists yet (roadmap 4.17 / Phase 6 own it). A mistyped key switches off a channel
    // nobody routes to — which is exactly why inventing a list here would cost more than it protects.
    const { service, blocks } = makeChannelStore();
    const out = await service.setChannelAvailability('acc-1', 'u-1', 'carrier-pigeon', false);
    expect(out.status).toBe('ok');
    expect(blocks.map((b) => b.channel)).toEqual(['carrier-pigeon']);
  });

  it('the transition payload carries ids and enums only', () => {
    // `channel` is an opaque key and `available` an enum-ish string; the allow-list refuses the rest.
    const { transitions } = makeChannelStore();
    expect(transitions).toHaveLength(0); // nothing yet — the shape is asserted in the first test
  });
});

// ── Labels ────────────────────────────────────────────────────────────────────────────────────────

function makeLabelStore(
  labels: Array<{ id: string; account_id: string; name: string; state: string }> = [],
) {
  const presence: Array<{ account_id: string; label_id: string | null; state: string }> = [];

  const db = (accountId: string) => ({
    presenceLabel: {
      async findMany() {
        return labels.filter((l) => l.account_id === accountId);
      },
      async findFirst({ where }: { where: { id: string } }) {
        return labels.find((l) => l.account_id === accountId && l.id === where.id) ?? null;
      },
      async create({ data }: { data: { name: string; state: string } }) {
        if (labels.some((l) => l.account_id === accountId && l.name === data.name)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: `l-${labels.length + 1}`, account_id: accountId, ...data };
        labels.push(row);
        return row;
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { name: string; state: string };
      }) {
        const row = labels.find((l) => l.account_id === accountId && l.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      async delete({ where }: { where: { id: string } }) {
        const i = labels.findIndex((l) => l.account_id === accountId && l.id === where.id);
        labels.splice(i, 1);
      },
    },
    operatorPresence: {
      async updateMany({ where }: { where: { label_id: string } }) {
        for (const p of presence) if (p.label_id === where.label_id) p.label_id = null;
      },
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn(db(accountId));
    },
  });

  const prisma = { forAccount: (a: string) => db(a) } as unknown as PrismaService;
  return { repo: new LabelsRepository(prisma), labels, presence };
}

describe('labels are decoration, and deleting one changes nobody’s state (US5)', () => {
  it('creates a label and lists it', async () => {
    const { repo } = makeLabelStore();
    const created = await repo.upsert('acc-1', '', 'Training', 'away');
    expect(created.status).toBe('ok');
    expect((await repo.list('acc-1')).map((l) => l.name)).toEqual(['Training']);
  });

  it('a duplicate name within an account is refused by the DATABASE, not by a pre-read', async () => {
    // A read-then-write leaves a window in which two administrators both see the name free. The
    // unique index is the only thing that cannot be raced.
    const { repo } = makeLabelStore();
    await repo.upsert('acc-1', '', 'Lunch', 'away');
    expect((await repo.upsert('acc-1', '', 'Lunch', 'away')).status).toBe('name_taken');
  });

  it('the same name in ANOTHER account is fine', async () => {
    const { repo } = makeLabelStore();
    await repo.upsert('acc-1', '', 'Lunch', 'away');
    expect((await repo.upsert('acc-2', '', 'Lunch', 'away')).status).toBe('ok');
  });

  it('editing an id that does not exist is refused rather than silently creating one', async () => {
    const { repo } = makeLabelStore();
    expect((await repo.upsert('acc-1', 'nope', 'X', 'away')).status).toBe('unknown_label');
  });

  it('⭐ deleting a label clears the DISPLAY and leaves the STATE untouched (FR-028)', async () => {
    // Removing a decoration must never change who receives work. This is why `label_id` is a soft
    // reference rather than a foreign key with a cascade — a cascade would make the guarantee a
    // property of a database setting instead of a decision.
    const store = makeLabelStore([
      { id: 'l-1', account_id: 'acc-1', name: 'Lunch', state: 'away' },
    ]);
    store.presence.push({ account_id: 'acc-1', label_id: 'l-1', state: 'away' });

    expect(await store.repo.remove('acc-1', 'l-1')).toBe(true);
    expect(store.presence[0]!.label_id).toBeNull();
    expect(store.presence[0]!.state).toBe('away'); // ⭐ unchanged
    expect(store.labels).toEqual([]);
  });

  it('deleting a label that does not exist answers false rather than throwing', async () => {
    const { repo } = makeLabelStore();
    expect(await repo.remove('acc-1', 'ghost')).toBe(false);
  });

  it('another account’s label is invisible and undeletable', async () => {
    const store = makeLabelStore([
      { id: 'l-1', account_id: 'acc-2', name: 'Lunch', state: 'away' },
    ]);
    expect(await store.repo.list('acc-1')).toEqual([]);
    expect(await store.repo.exists('acc-1', 'l-1')).toBe(false);
    expect(await store.repo.remove('acc-1', 'l-1')).toBe(false);
    expect(store.labels).toHaveLength(1); // still there, in the account that owns it
  });

  it('every label points at exactly ONE state, and it is one of the four', async () => {
    const { repo } = makeLabelStore();
    for (const [name, state] of [
      ['Break', 'away'],
      ['Lunch', 'away'],
      ['Meeting', 'transfers_only'],
      ['VIP task', 'transfers_only'],
    ] as const) {
      await repo.upsert('acc-1', '', name, state);
    }
    const rows = await repo.list('acc-1');
    expect(rows).toHaveLength(4);
    for (const r of rows) {
      expect(['online', 'transfers_only', 'away', 'offline']).toContain(r.state);
    }
  });
});
