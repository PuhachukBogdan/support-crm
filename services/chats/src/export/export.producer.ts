import { Inject, Injectable } from '@nestjs/common';
import { csvRow, type CsvSink, type ExportScope } from '@crm/common';
import { ConversationRepository, type ListFilters } from '../conversation/conversation.repository';
import { SlaRepository } from '../sla/sla.repository';
import type { Cursor } from '../shared/cursor';

/**
 * The export producer (feature 017, US1 — FR-004/FR-004a/FR-004b/FR-007).
 *
 * ── It REUSES the conversation read path; it does not reimplement one ────────────────────────────
 * Filters, keyset order and row shaping all come from `ConversationRepository.list`, under the same
 * account-scoped client. That is FR-004a: **a file is a projection like any other**, and the guarantee
 * that made feature 012's customer view safe cannot be one that only the API respects. An export that
 * rebuilt its own row-shaping would be 012's live defect — the REST edge silently coercing an unknown
 * `kind` and publishing a private note — with a wider blast radius, because a file gets forwarded.
 *
 * ── What the v1 column set can and cannot contain ────────────────────────────────────────────────
 * Conversation-level fields ONLY (FR-004b). No message body, no private note, no attachment reference.
 * That is why the SEC-13 private-note question does not arise here: the payload cannot contain a note,
 * so there is nothing to exclude and nothing to get wrong. `COLUMNS` below is the whole claim, and
 * `export.producer.spec.ts` asserts no message-content field can appear in it.
 *
 * ── Caps refuse; they never truncate ────────────────────────────────────────────────────────────
 * A short file is a wrong answer that looks like a right one, and the person holding it has no way to
 * know rows are missing. Both limits therefore throw.
 */
export class RowLimitExceededError extends Error {
  constructor() {
    super('row limit exceeded');
    this.name = 'RowLimitExceededError';
  }
}
export class ByteLimitExceededError extends Error {
  constructor() {
    super('byte limit exceeded');
    this.name = 'ByteLimitExceededError';
  }
}

/**
 * The v1 conversations column set.
 *
 * Deliberately a flat list of conversation-level fields. Adding a message-content column here would be
 * adding a different scope (with its own permission key), not extending this one — see FR-004b.
 */
export const CONVERSATION_EXPORT_COLUMNS = [
  'id',
  'brand_id',
  'player_id',
  'status',
  'priority',
  'assignee_operator_id',
  'channel',
  'created_at',
  'updated_at',
] as const;

/** How many source rows are fetched per page. Independent of the row LIMIT — see `produce`. */
const PAGE_SIZE = 500;

export interface ProduceResult {
  rowCount: number;
  byteSize: number;
}

/**
 * The filters as STORED on the export record: the list's own filter set, plus the SLA outcome, which the
 * list resolves into an id set rather than passing to the query.
 */
export type ExportFilterSet = Omit<ListFilters, 'limit' | 'cursor'> & { slaOutcome?: string };

@Injectable()
export class ExportProducer {
  constructor(
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(SlaRepository) private readonly sla: SlaRepository,
  ) {}

  /**
   * Page the source rows into `sink`, returning the counts the audit entry reports.
   *
   * The sink is what makes FR-007 testable rather than asserted: nothing here accumulates rows, so a
   * test can drive the producer with far more rows than `PAGE_SIZE` and watch that memory does not grow
   * with the result set. A `string[]` return type would have made "does not materialise the whole
   * result set" an unverifiable claim in a comment.
   */
  async produce(
    accountId: string,
    scope: ExportScope,
    filters: ExportFilterSet,
    sink: CsvSink,
  ): Promise<ProduceResult> {
    sink.write(csvRow([...CONVERSATION_EXPORT_COLUMNS]));

    /**
     * The SLA filter is resolved into an id set, exactly as `ListConversations` does — and HERE, at
     * production time, not at request time.
     *
     * ⚠️ Added after Track B: the export accepted `slaOutcome` at the edge and then dropped it entirely,
     * so a request for breached conversations produced **every** conversation. That is the widening
     * direction, and the worse one — an empty file is obviously wrong to whoever opens it, while a file
     * with too much in it looks exactly like a correct answer and then gets forwarded.
     *
     * Resolved at production time because "export what I am looking at" means the rows the list would
     * return, and the list resolves this set when it reads. Freezing an id set at request time would also
     * mean storing an unbounded array in the export record.
     *
     * An EMPTY set is a real answer — "no conversation has that outcome" — and must produce an empty
     * file, never an unfiltered one. `ListFilters.idIn` already carries that contract.
     */
    const { slaOutcome, ...listFilters } = filters;
    const resolved: Omit<ListFilters, 'limit' | 'cursor'> = slaOutcome
      ? { ...listFilters, idIn: await this.sla.conversationIdsByOutcome(accountId, slaOutcome) }
      : listFilters;

    let rowCount = 0;
    let cursor: Cursor | null = null;

    for (;;) {
      const page = await this.conversations.list(accountId, {
        ...resolved,
        limit: PAGE_SIZE,
        cursor,
      });

      for (const row of page.rows) {
        rowCount += 1;
        // Checked BEFORE writing the offending row, so the sink never holds a row beyond the limit.
        if (rowCount > scope.rowLimit) throw new RowLimitExceededError();
        const cells = row as unknown as Record<string, unknown>;
        sink.write(csvRow(CONVERSATION_EXPORT_COLUMNS.map((c) => serialize(cells, c))));
        if (sink.byteLength > scope.maxBytes) throw new ByteLimitExceededError();
      }

      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    return { rowCount, byteSize: sink.byteLength };
  }
}

/**
 * One cell.
 *
 * Dates go out as ISO-8601 — a locale-formatted date in a CSV is ambiguous to every consumer that is
 * not the machine that produced it. `null`/`undefined` become an empty field, never the literal text
 * "null" (which would be indistinguishable from a value that IS the word). Formula neutralisation and
 * quoting happen in the shared writer, not here.
 */
function serialize(row: Record<string, unknown>, column: string): unknown {
  const value = row[column];
  if (value instanceof Date) return value.toISOString();
  return value ?? '';
}
