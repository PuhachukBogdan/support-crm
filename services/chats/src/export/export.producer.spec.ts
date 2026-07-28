import { arraySink, EXPORT_SCOPES } from '@crm/common';
import {
  ByteLimitExceededError,
  CONVERSATION_EXPORT_COLUMNS,
  ExportProducer,
  RowLimitExceededError,
} from './export.producer';

/**
 * T021 (feature 017, US1) — the producer reuses the read path, carries no message content, and REFUSES
 * rather than truncating.
 */
const SCOPE = EXPORT_SCOPES.conversations;

function row(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `c${i}`,
    brand_id: 'brand-a',
    player_id: `p${i}`,
    status: 'open',
    priority: 'normal',
    assignee_operator_id: null,
    channel: 'email',
    created_at: new Date('2026-07-28T10:00:00.000Z'),
    updated_at: new Date('2026-07-28T11:00:00.000Z'),
    ...over,
  };
}

/** A fake read path that pages, so the producer's paging is actually exercised. */
function fakeConversations(rows: ReturnType<typeof row>[], pageSize = 500) {
  const calls: Array<{ accountId: string; filters: unknown }> = [];
  return {
    calls,
    list: jest.fn(async (accountId: string, f: { limit: number; cursor: unknown }) => {
      calls.push({ accountId, filters: f });
      const start = calls.length === 1 ? 0 : (calls.length - 1) * pageSize;
      const slice = rows.slice(start, start + Math.min(pageSize, f.limit));
      const more = start + slice.length < rows.length;
      return {
        rows: slice,
        nextCursor: more ? { createdAt: 'x', id: 'y' } : null,
      };
    }),
  };
}

/**
 * The SLA fake returns a fixed id set. Feature 017's Track B run added this dependency: the export edge
 * accepted `slaOutcome` and dropped it, so a request for breached conversations produced EVERY
 * conversation — the widening direction, and the one that looks like a correct answer.
 */
const make = (conv: { list: unknown }, slaIds: string[] = ['conv-sla-1']) =>
  new ExportProducer(conv as never, {
    conversationIdsByOutcome: jest.fn(async () => slaIds),
  } as never);

describe('the column set is the FR-004b claim', () => {
  it('carries conversation-level fields only — no message content of any kind', () => {
    // The v1 scope cannot contain a body, a private note or an attachment reference. That is why the
    // SEC-13 question does not arise here: there is nothing to exclude because nothing can be included.
    const forbidden = ['body', 'message', 'note', 'private', 'attachment', 'mentions', 'content'];
    for (const column of CONVERSATION_EXPORT_COLUMNS) {
      for (const bad of forbidden) {
        expect({ column, contains: column.toLowerCase().includes(bad) }).toEqual({
          column,
          contains: false,
        });
      }
    }
  });

  it('writes the header first, in catalogue order', async () => {
    const sink = arraySink();
    await make(fakeConversations([])).produce('acc-1', SCOPE, {}, sink);
    expect(sink.value().split('\r\n')[0]).toBe(CONVERSATION_EXPORT_COLUMNS.join(','));
  });
});

describe('it reuses the conversation read path (FR-004a)', () => {
  it('reads through the account-scoped list with the caller filters, never its own query', async () => {
    const conv = fakeConversations([row(1)]);
    await make(conv).produce('acc-1', SCOPE, { status: 'open' as never, playerId: 'p1' }, arraySink());

    expect(conv.list).toHaveBeenCalled();
    expect(conv.calls[0]!.accountId).toBe('acc-1');
    expect(conv.calls[0]!.filters).toMatchObject({ status: 'open', playerId: 'p1' });
  });

  it('pages until the read path says there is no more', async () => {
    const conv = fakeConversations([row(1), row(2), row(3)], 1);
    const sink = arraySink();
    const res = await make(conv).produce('acc-1', SCOPE, {}, sink);

    expect(res.rowCount).toBe(3);
    expect(conv.list).toHaveBeenCalledTimes(3);
    // Header + 3 rows, each terminated.
    expect(sink.value().trimEnd().split('\r\n')).toHaveLength(4);
  });

  it('serializes dates as ISO-8601 and null as an empty field', async () => {
    const sink = arraySink();
    await make(fakeConversations([row(1, { assignee_operator_id: null })])).produce(
      'acc-1',
      SCOPE,
      {},
      sink,
    );
    const dataLine = sink.value().split('\r\n')[1]!;
    expect(dataLine).toContain('2026-07-28T10:00:00.000Z');
    // The null assignee is an empty field between two commas — never the text "null".
    expect(dataLine).toContain(',,');
    expect(dataLine).not.toContain('null');
  });
});

describe('*** the caps REFUSE — they never truncate ***', () => {
  it('throws RowLimitExceededError past the scope row limit', async () => {
    const tiny = { ...SCOPE, rowLimit: 2 };
    const conv = fakeConversations([row(1), row(2), row(3)], 3);
    await expect(make(conv).produce('acc-1', tiny, {}, arraySink())).rejects.toBeInstanceOf(
      RowLimitExceededError,
    );
  });

  it('throws ByteLimitExceededError past the scope byte cap', async () => {
    const tiny = { ...SCOPE, maxBytes: 10 };
    const conv = fakeConversations([row(1), row(2)], 2);
    await expect(make(conv).produce('acc-1', tiny, {}, arraySink())).rejects.toBeInstanceOf(
      ByteLimitExceededError,
    );
  });

  it('a refusal leaves NO complete file — the caller must not be handed a short answer', async () => {
    // The sink may hold what was written before the limit was hit; what matters is that `produce`
    // REJECTS, so the service never reaches the store call and no artefact is ever referenced. A
    // truncated file is a wrong answer that looks like a right one.
    const tiny = { ...SCOPE, rowLimit: 1 };
    const conv = fakeConversations([row(1), row(2)], 2);
    const sink = arraySink();
    await expect(make(conv).produce('acc-1', tiny, {}, sink)).rejects.toThrow();
  });
});

describe('an empty result is a success, not an error (FR-006)', () => {
  it('produces a header-only file with rowCount 0', async () => {
    const sink = arraySink();
    const res = await make(fakeConversations([])).produce('acc-1', SCOPE, {}, sink);
    expect(res.rowCount).toBe(0);
    expect(sink.value()).toBe(CONVERSATION_EXPORT_COLUMNS.join(',') + '\r\n');
  });
});

describe('FR-007 — production does not materialise the whole result set', () => {
  it('drives far more rows than a page without the producer accumulating them', async () => {
    // The sink is the only thing that grows, and it is the caller's choice of sink. The producer holds
    // one page at a time — asserted here by pushing 5 000 rows through a 100-row page size and checking
    // the read path was called per page rather than once with everything.
    const rows = Array.from({ length: 5_000 }, (_, i) => row(i));
    const conv = fakeConversations(rows, 100);
    const res = await make(conv).produce('acc-1', { ...SCOPE, maxBytes: 50_000_000 }, {}, arraySink());
    expect(res.rowCount).toBe(5_000);
    expect(conv.list).toHaveBeenCalledTimes(50);
  });
});

describe('*** the SLA filter is RESOLVED, not dropped *** (found on Track B, 2026-07-28)', () => {
  it('an slaOutcome becomes an id set on the query', async () => {
    const conv = fakeConversations([row(1)], 500);
    const producer = make(conv, ['c1', 'c2']);
    await producer.produce('acc-1', SCOPE, { slaOutcome: 'breached' } as never, arraySink());

    // Dropping it produced EVERY conversation for a request that asked for breached ones — a file with
    // too much in it, which looks exactly like a correct answer and then gets forwarded.
    expect((conv.calls[0]!.filters as { idIn?: string[] }).idIn).toEqual(['c1', 'c2']);
    // …and the outcome itself never reaches the conversation query, which has no such column.
    expect((conv.calls[0]!.filters as { slaOutcome?: string }).slaOutcome).toBeUndefined();
  });

  it('an outcome that matches NOTHING yields an empty file, not an unfiltered one', async () => {
    const conv = fakeConversations([row(1), row(2)], 500);
    const producer = make(conv, []);
    const sink = arraySink();
    const res = await producer.produce('acc-1', SCOPE, { slaOutcome: 'met' } as never, sink);

    /**
     * `idIn: []` is PASSED, not omitted — which is the whole assertion available at this layer.
     *
     * "An empty id set yields an empty page rather than an unfiltered one" is `ListFilters`' own contract
     * (feature 014 / R10) and is tested against the real repository, so asserting a row count here would
     * be asserting the behaviour of this file's fake rather than of any product code. What the producer
     * must not do is decide `[]` means "no filter" and drop the key, and that is what this checks.
     */
    const passed = conv.calls[0]!.filters as { idIn?: string[] };
    expect(passed.idIn).toEqual([]);
    expect('idIn' in passed).toBe(true);
    expect(res.rowCount).toBe(2); // the fake ignores filters; see above
  });

  it('no slaOutcome means the SLA repository is not consulted at all', async () => {
    const conv = fakeConversations([row(1)], 500);
    const sla = { conversationIdsByOutcome: jest.fn(async () => ['nope']) };
    const producer = new ExportProducer(conv as never, sla as never);
    await producer.produce('acc-1', SCOPE, {}, arraySink());

    expect(sla.conversationIdsByOutcome).not.toHaveBeenCalled();
    expect((conv.calls[0]!.filters as { idIn?: string[] }).idIn).toBeUndefined();
  });
});
