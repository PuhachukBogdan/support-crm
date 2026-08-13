import type { DataAccess, RealtimeEvent } from '@/data/data-access';
import type { DataError, PaginatedResult, Query, ResourceName } from '@/data/types';
import { WIRE_STATUSES, type StatusWireRow } from '@/features/inbox/test-support';
import type { ConversationDetail, LabelWire, ThreadMessage } from './types';

/**
 * A `DataAccess` for the ticket window (W7). Same philosophy as the Inbox's stub: it proves the
 * SHAPE — which request the screen composes, in which ORDER, and what renders per state. Whether
 * the real gateway honours it is Track B's claim (`deploy/local/w7-browser-check.mjs`).
 *
 * Every write lands in `writes` in call order, so a test can assert sequencing (message BEFORE
 * status) and absence (two clicks, one create) — the two properties the sagas exist to guarantee.
 */
export interface TicketStubOptions {
  detail?: Partial<ConversationDetail>;
  messages?: ThreadMessage[];
  labels?: LabelWire[];
  accountLabels?: LabelWire[];
  myOperatorId?: string | null;
  statuses?: readonly StatusWireRow[];
  /** Every `create conversation-messages` fails with this. */
  failSendWith?: DataError;
  /** The detail read fails (the thread may still answer). */
  failDetailWith?: DataError;
}

export interface WriteRecord {
  op: 'create' | 'update' | 'remove';
  resource: ResourceName;
  id?: string;
  payload?: unknown;
  within?: string;
}

export interface TicketStub extends DataAccess {
  writes: WriteRecord[];
  threadReads: number;
  detailReads: number;
  emit(event: RealtimeEvent): void;
}

export function makeDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'c1',
    brandId: 'brand-a',
    playerId: 'player-7',
    statusKey: 'open',
    statusCategory: 'CONVERSATION_STATUS_CATEGORY_OPEN',
    priority: 'normal',
    assigneeOperatorId: 'op-someone-else',
    channel: 'chat',
    reference: 'REF-1',
    category: '',
    subCategory: '',
    classifiedBy: '',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-06T09:00:00.000Z',
    subject: 'Deposit stuck',
    subjectSource: 'auto',
    routedGroupId: '',
    identityState: 'identified',
    continuesConversationId: '',
    ...overrides,
  };
}

let messageSeq = 0;

export function makeMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  messageSeq += 1;
  return {
    id: `m-auto-${messageSeq}`,
    conversationId: 'c1',
    kind: 'MESSAGE_KIND_PUBLIC_REPLY',
    authorId: 'op-1',
    body: 'hello',
    mentions: [],
    createdAt: '2026-08-06T08:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

export function stubTicket(opts: TicketStubOptions = {}): TicketStub {
  const detail = makeDetail(opts.detail ?? {});
  let messages = opts.messages ?? [makeMessage({ id: 'm1' })];
  const labels = opts.labels ?? [];
  const accountLabels = opts.accountLabels ?? [];
  const writes: WriteRecord[] = [];
  const watchers = new Set<(event: RealtimeEvent) => void>();

  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });

  const stub: TicketStub = {
    writes,
    threadReads: 0,
    detailReads: 0,
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      if (resource === 'conversation-statuses')
        return page((opts.statuses ?? WIRE_STATUSES) as unknown as T[]);
      if (resource === 'conversation-thread') {
        if (query.within !== detail.id) throw new Error(`thread read for wrong id: ${query.within}`);
        stub.threadReads += 1;
        return page(messages as unknown as T[]);
      }
      if (resource === 'conversation-labels') return page(labels as unknown as T[]);
      if (resource === 'labels') return page(accountLabels as unknown as T[]);
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(resource: ResourceName, id: string): Promise<T> {
      if (resource === 'me-operator') {
        if (opts.myOperatorId === null) throw { kind: 'unavailable' };
        return { operatorId: opts.myOperatorId ?? 'op-me', active: true } as unknown as T;
      }
      if (resource === 'conversations') {
        stub.detailReads += 1;
        if (opts.failDetailWith) throw opts.failDetailWith;
        if (id !== detail.id) throw { message: 'not found', retryable: false };
        return detail as unknown as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: ResourceName, input: unknown, within?: string): Promise<T> {
      writes.push({ op: 'create', resource, payload: input, within });
      if (resource === 'conversation-messages') {
        if (opts.failSendWith) throw opts.failSendWith;
        const body = (input as { body?: string }).body ?? '';
        const kind = (input as { kind?: string }).kind === 'note'
          ? 'MESSAGE_KIND_PRIVATE_NOTE'
          : 'MESSAGE_KIND_PUBLIC_REPLY';
        // The stub's thread grows the way the server's would, so the re-read the saga fires
        // renders the new message — the same "appears when the read returns it" the product has.
        messages = [...messages, makeMessage({ id: `m-sent-${writes.length}`, body, kind })];
        return { id: `m-sent-${writes.length}` } as unknown as T;
      }
      throw new Error(`unexpected create: ${resource}`);
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T> {
      writes.push({ op: 'update', resource, id, payload: patch, within });
      return {} as T;
    },
    async remove(resource: ResourceName, id: string, within?: string): Promise<void> {
      writes.push({ op: 'remove', resource, id, within });
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
