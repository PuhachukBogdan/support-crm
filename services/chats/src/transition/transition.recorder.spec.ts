import { Metadata } from '@grpc/grpc-js';
import { TransitionRecorder, TransitionTypeError, type TransitionTx } from './transition.recorder';
import { buildTransitionDims } from './transition.dims';
import { TransitionPayloadError } from '@crm/common';

/**
 * T009 (feature 023, roadmap 4.8a) — the recorder refuses before it writes, and the snapshot is a
 * copy rather than a reference.
 */
const txWith = (rows: Record<string, unknown>[]): TransitionTx => ({
  conversationTransition: {
    create: async ({ data }) => {
      rows.push(data);
      return data;
    },
  },
});

const base = {
  accountId: 'acc-1',
  occurredAt: new Date('2026-08-01T10:00:00.000Z'),
  actorKind: 'user' as const,
  actorRef: 'user-1',
  subjectKind: 'conversation' as const,
  subjectId: 'conv-1',
  dims: {},
  correlationId: 'corr-1',
};

describe('TransitionRecorder', () => {
  it('writes one row inside the transaction it is given', async () => {
    const rows: Record<string, unknown>[] = [];
    await new TransitionRecorder().record(txWith(rows), {
      ...base,
      type: 'conversation.status_changed',
      payload: { from: 'open', to: 'resolved' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe('conversation.status_changed');
    expect(rows[0]!.occurred_at).toEqual(base.occurredAt);
  });

  it('refuses an unknown type BEFORE writing anything', async () => {
    const rows: Record<string, unknown>[] = [];
    await expect(
      new TransitionRecorder().record(txWith(rows), { ...base, type: 'conversation.nope' }),
    ).rejects.toThrow(TransitionTypeError);
    expect(rows).toHaveLength(0);
  });

  it('does not echo an unknown type back into the message (the 021 lesson)', async () => {
    const rows: Record<string, unknown>[] = [];
    const secret = 'some-caller-supplied-token';
    await expect(
      new TransitionRecorder().record(txWith(rows), { ...base, type: secret }),
    ).rejects.toThrow(/<\d+ chars>/);
    await expect(
      new TransitionRecorder().record(txWith(rows), { ...base, type: secret }),
    ).rejects.not.toThrow(new RegExp(secret));
  });

  it('refuses a payload the allow-list rejects, writing nothing', async () => {
    const rows: Record<string, unknown>[] = [];
    await expect(
      new TransitionRecorder().record(txWith(rows), {
        ...base,
        type: 'conversation.first_public_reply',
        payload: { messageId: 'm-1', body: 'hello' },
      }),
    ).rejects.toThrow(TransitionPayloadError);
    expect(rows).toHaveLength(0);
  });

  it('refuses a system act that does not name itself', async () => {
    const rows: Record<string, unknown>[] = [];
    await expect(
      new TransitionRecorder().record(txWith(rows), {
        ...base,
        actorKind: 'system',
        actorRef: null,
        type: 'conversation.status_changed',
        payload: { from: 'open', to: 'resolved' },
      }),
    ).rejects.toThrow(/must name itself/);
    expect(rows).toHaveLength(0);
  });

  it('never opens its own transaction — it writes through the client it is handed', async () => {
    // Structural: the injected tx is the ONLY write surface. If the recorder ever reached for its own
    // client, this fake would record nothing and the assertion below would fail.
    const rows: Record<string, unknown>[] = [];
    await new TransitionRecorder().record(txWith(rows), {
      ...base,
      type: 'conversation.assigned',
      payload: { from: null, to: 'op-2' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('buildTransitionDims — a snapshot, not a reference', () => {
  const md = (pairs: Record<string, string>) => {
    const m = new Metadata();
    for (const [k, v] of Object.entries(pairs)) m.set(k, v);
    return m;
  };

  it('copies the values in force at this instant', () => {
    const dims = buildTransitionDims(
      { brand_id: 'brand-a', channel: 'web', assignee_operator_id: 'op-1' },
      md({ 'x-actor-effective-role': 'support_agent' }),
    );
    expect(dims).toEqual({
      brand: 'brand-a',
      channel: 'web',
      assignee: 'op-1',
      submitterRole: 'support_agent',
    });
  });

  it('OMITS a dimension that does not exist — never null, never empty string', () => {
    // group (5.3) stays unbuilt; form (4.15) is written since W30 — but only when the row HAS one
    // (see the W30 describe below). An empty channel is absence, not a value.
    const dims = buildTransitionDims({ brand_id: 'brand-a', channel: null });
    expect(dims).toEqual({ brand: 'brand-a' });
    expect('channel' in dims).toBe(false);
    expect('group' in dims).toBe(false);
    expect('form' in dims).toBe(false);
  });

  it('reads the EFFECTIVE role, not the real one (feature 018 added both headers for a reason)', () => {
    const dims = buildTransitionDims(
      {},
      md({ 'x-actor-role': 'super_admin', 'x-actor-effective-role': 'support_agent' }),
    );
    // Under an owner view-as preview these differ; the reporting dimension is what they acted as.
    expect(dims.submitterRole).toBe('support_agent');
  });

  it('is a plain value object — nothing in it can be re-resolved later', () => {
    const dims = buildTransitionDims({ brand_id: 'brand-a' });
    expect(JSON.parse(JSON.stringify(dims))).toEqual(dims);
  });
});

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the `form` dimension the header reserved, now written.
 * Going forward only: a row with a `form_key` snapshots it; a row without one stays ABSENT in
 * `dims_json` (never `null` — old rows need no backfill and no reinterpretation).
 */
describe('W30 — the form dimension in dims_json', () => {
  it('⭐ a row with a form_key carries `form` all the way into the written dims_json', async () => {
    const rows: Record<string, unknown>[] = [];
    await new TransitionRecorder().record(txWith(rows), {
      ...base,
      type: 'conversation.status_changed',
      payload: { from: 'open', to: 'resolved' },
      dims: buildTransitionDims({ brand_id: 'brand-a', form_key: 'deposits' }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dims_json).toEqual({ brand: 'brand-a', form: 'deposits' });
  });

  it('a NULL form_key writes NO form key at all — absent in dims_json, not null', async () => {
    const dims = buildTransitionDims({ brand_id: 'brand-a', form_key: null });
    expect('form' in dims).toBe(false);

    const rows: Record<string, unknown>[] = [];
    await new TransitionRecorder().record(txWith(rows), {
      ...base,
      type: 'conversation.status_changed',
      payload: { from: 'open', to: 'resolved' },
      dims,
    });
    const written = rows[0]!.dims_json as Record<string, unknown>;
    expect('form' in written).toBe(false);
    expect(written).toEqual({ brand: 'brand-a' });
  });
});
