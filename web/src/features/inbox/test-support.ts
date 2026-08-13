import { fireEvent, screen, within } from '@testing-library/react';
import type { DataAccess, RealtimeEvent } from '@/data/data-access';
import type { DataError, PaginatedResult, Query, ResourceName } from '@/data/types';
import type { ConversationRow } from './types';

/**
 * A `DataAccess` that serves conversation-shaped rows (feature 029, Track A only).
 *
 * ⚠️ `MockDataAccess` cannot be used for these screens: it serves `DemoRecord`s and declares no
 * orders, so the Inbox's order parameter is refused by it. That refusal is correct and deliberate
 * (see the class), which is exactly why the screen needs its own stub rather than a loosened mock.
 *
 * ⚠️⚠️ **What this stub can and cannot prove.** It returns whatever it is handed, so a filter it
 * honours and a filter the real gateway silently drops look identical here. Every claim about a
 * filter actually narrowing, an order actually ordering, or paging not repeating rows belongs to
 * Track B. What Track A proves is the SHAPE: which request the screen composes, and what it renders
 * for each state.
 */
export interface StubOptions {
  count?: number;
  /** Total across all pages; pages are sliced at `pageSize`. */
  pageSize?: number;
  delayMs?: number;
  failWith?: DataError | null;
  /** Overrides applied to every generated row. */
  rowOverrides?: Partial<ConversationRow>;
}

export function makeConversationRows(
  count: number,
  overrides: Partial<ConversationRow> = {},
): ConversationRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `conv-${String(i + 1).padStart(4, '0')}`,
    brandId: 'brand-a',
    playerId: `player-${i + 1}`,
    /**
     * ⚠️ **The WIRE value, not the pretty one.** This said `'open'` and the screen's whole suite was
     * green while the live screen showed `conversation_status_open` in the Status column — the
     * gateway sends `CONVERSATION_STATUS_OPEN`. A stub that invents a friendlier shape than the
     * server's cannot catch a translation that is missing, which is the one thing it most needs to.
     */
    status: 'CONVERSATION_STATUS_OPEN',
    priority: 'normal',
    assigneeOperatorId: `op-${i + 1}`,
    channel: 'chat',
    // Descending by default, matching the screen's default order.
    lastActivityAt: new Date(Date.UTC(2026, 7, 2, 12, 0, count - i)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 7, 1, 9, 0, count - i)).toISOString(),
    subject: `Conversation ${i + 1}`,
    ...overrides,
  }));
}

/** Records every list call, so a test can assert WHICH request the screen composed. */
export interface ConversationsStub extends DataAccess {
  calls: Query[];
  /**
   * Deliver a realtime event as if the gateway had sent one (feature 034, W4).
   *
   * ⚠️ A real registry rather than a `() => () => undefined` stub, and that is the difference between
   * testing this block and not: `calls` already records every read, so `emit` + `calls.length` is exactly
   * *"an event arrived, and the screen re-read once"* — with no socket, no gateway and no Redis anywhere
   * near it.
   */
  emit(event: RealtimeEvent): void;
}

export function stubConversations(opts: StubOptions = {}): ConversationsStub {
  const total = opts.count ?? 5;
  const pageSize = opts.pageSize ?? 50;
  const rows = makeConversationRows(total, opts.rowOverrides ?? {});
  const calls: Query[] = [];
  const watchers = new Set<(event: RealtimeEvent) => void>();

  const stub: ConversationsStub = {
    calls,
    async list<T = unknown>(_resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      calls.push(query);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.failWith) throw opts.failWith;

      const start = query.cursor ? Number(query.cursor) : 0;
      const slice = rows.slice(start, start + pageSize);
      const next = start + slice.length;
      const hasMore = next < rows.length;
      return {
        items: slice as unknown as T[],
        nextCursor: hasMore ? String(next) : null,
        hasMore,
      };
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used by the inbox');
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used by the inbox');
    },
    async update<T = unknown>(): Promise<T> {
      throw new Error('not used by the inbox');
    },
    async remove(): Promise<void> {
      throw new Error('not used by the inbox');
    },
    subscribe(handler: (event: RealtimeEvent) => void): () => void {
      watchers.add(handler);
      return () => {
        watchers.delete(handler);
      };
    },
    emit(event: RealtimeEvent): void {
      for (const handler of watchers) handler(event);
    },
  };
  return stub;
}

/**
 * Operate one of the toolbar dropdowns the way a person does.
 *
 * ⚠️ These are **Radix** selects, not native `<select>` elements, so `fireEvent.change` and
 * `selectOption` do nothing: the list is a popup rendered into the page, opened by a pointer event on
 * the trigger. The move off native selects was itself a bug fix — an OS dropdown popup froze the
 * renderer at 100% CPU when the list re-rendered as it closed (`choice.tsx`).
 *
 * ⓘ This still cannot prove the popup behaves in a real browser; that is what the headed checks in
 * `specs/029-inbox/browser-checks.mjs` are for. What it proves is which request the screen composes.
 */
export function chooseOption(testId: string, optionLabel: string | RegExp): void {
  const trigger = screen.getByTestId(testId);
  // ⓘ `click`, not `pointerDown`: jsdom has no real PointerEvent, so Radix's pointer handler never
  // fires. Measured against the alternatives before choosing — keyboard also works, click reads
  // closer to what a person does.
  fireEvent.click(trigger);
  const listbox = screen.getByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: optionLabel }));
}

/** The option labels a dropdown currently offers, in order. */
export function optionsOf(testId: string): string[] {
  const trigger = screen.getByTestId(testId);
  // ⓘ `click`, not `pointerDown`: jsdom has no real PointerEvent, so Radix's pointer handler never
  // fires. Measured against the alternatives before choosing — keyboard also works, click reads
  // closer to what a person does.
  fireEvent.click(trigger);
  const listbox = screen.getByRole('listbox');
  return within(listbox)
    .getAllByRole('option')
    .map((o) => (o.textContent ?? '').trim());
}
