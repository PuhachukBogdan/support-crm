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

const make = (conv: { list: unknown }) =>
  new ExportProducer(conv as never);

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
