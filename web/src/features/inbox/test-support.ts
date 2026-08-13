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
  /**
   * W6: the caller's own operator id (`GET /me/operator`). `null` = the read FAILS — how every test
   * written before 5.11 implicitly ran, and the state the «Мои» control must stay disabled in.
   */
  myOperatorId?: string | null;
  /** W6: the status catalogue. Defaults to a seeded-nine-shaped set; `[]` = the read fails. */
  statuses?: readonly StatusWireRow[];
  /** ⭐ W25: what `GET inbox-unseen` answers — the mark BEFORE this visit, and the derived count. */
  unseen?: { count?: number; openedAt?: string };
}

/** The catalogue row as the WIRE spells it (`GET /conversations/statuses`, feature 032). */
export interface StatusWireRow {
  key: string;
  category: string;
  agentName: string;
  endUserName: string;
  active: boolean;
  order: number;
}

/**
 * The seeded nine, in wire shape — the same set `@crm/common` seeds, restated here because `web/`
 * deliberately imports nothing from the services' shared library (the same rule as `RealtimeEvent`).
 */
export const WIRE_STATUSES: readonly StatusWireRow[] = [
  { key: 'new', category: 'CONVERSATION_STATUS_CATEGORY_NEW', agentName: 'New', endUserName: 'Open', active: true, order: 10 },
  { key: 'open', category: 'CONVERSATION_STATUS_CATEGORY_OPEN', agentName: 'Open', endUserName: 'Open', active: true, order: 20 },
  { key: 'pending', category: 'CONVERSATION_STATUS_CATEGORY_PENDING', agentName: 'Pending', endUserName: 'Open', active: true, order: 30 },
  { key: 'vip_pending', category: 'CONVERSATION_STATUS_CATEGORY_PENDING', agentName: 'VIP Pending', endUserName: 'Open', active: true, order: 40 },
  { key: 'in_progress', category: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD', agentName: 'In progress', endUserName: 'Open', active: true, order: 50 },
  { key: 'follow_up', category: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD', agentName: 'Follow-up', endUserName: 'Open', active: true, order: 60 },
  // Retired: still on old rows, never offered as a filter option.
  { key: 'auto_ended_chat', category: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD', agentName: 'Auto-Ended Chat', endUserName: 'Open', active: false, order: 70 },
  { key: 'supervisor_review', category: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD', agentName: 'Supervisor Review – In Progress', endUserName: 'Open', active: true, order: 80 },
  { key: 'solved', category: 'CONVERSATION_STATUS_CATEGORY_SOLVED', agentName: 'Solved', endUserName: 'Solved', active: true, order: 90 },
];

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
  /** ⭐ W25: how many times the screen PUT the reset (`inbox-opened`) — rule 2's countable half. */
  openedCalls: number;
  /** ⭐ W25: what `inbox-unseen` answers NEXT — mutable, so a test moves the server between events. */
  unseen?: { count?: number; openedAt?: string };
}

export function stubConversations(opts: StubOptions = {}): ConversationsStub {
  const total = opts.count ?? 5;
  const pageSize = opts.pageSize ?? 50;
  const rows = makeConversationRows(total, opts.rowOverrides ?? {});
  const calls: Query[] = [];
  const watchers = new Set<(event: RealtimeEvent) => void>();

  const stub: ConversationsStub = {
    calls,
    openedCalls: 0,
    unseen: opts.unseen,
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      // W6: the status catalogue rides the same port. Not recorded in `calls` — those are the
      // CONVERSATION requests the assertions count, and a catalogue read among them would make
      // "re-read once" flaky on mount order.
      if (resource === 'conversation-statuses') {
        const statuses = opts.statuses ?? WIRE_STATUSES;
        if (statuses.length === 0) throw { kind: 'unavailable' };
        return { items: statuses as unknown as T[], nextCursor: null, hasMore: false };
      }
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
    async get<T = unknown>(resource: ResourceName): Promise<T> {
      // W6: "which operator am I?" (5.11). `null` = the read fails, the scope stays disabled.
      if (resource === 'me-operator') {
        if (opts.myOperatorId === null) throw { kind: 'unavailable' };
        return { operatorId: opts.myOperatorId ?? 'op-me', active: true } as unknown as T;
      }
      // ⭐ W25: the page reads the unread mark on mount (for the row dots), then resets it.
      // Reads the MUTABLE property, so a test can move the server's number between events.
      if (resource === 'inbox-unseen') {
        return { count: stub.unseen?.count ?? 0, openedAt: stub.unseen?.openedAt ?? '' } as unknown as T;
      }
      throw new Error('not used by the inbox');
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used by the inbox');
    },
    async update<T = unknown>(resource?: unknown): Promise<T> {
      // ⭐ W25: the reset act — recorded so a spec can assert rule 2 (re-mark on arrival while open).
      if (resource === 'inbox-opened') {
        stub.openedCalls += 1;
        return { count: 0, openedAt: new Date().toISOString() } as unknown as T;
      }
      throw new Error('not used by the inbox');
    },
    async remove<T = void>(): Promise<T> {
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
