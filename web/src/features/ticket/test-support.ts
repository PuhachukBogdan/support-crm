import type { DataAccess, RealtimeEvent } from '@/data/data-access';
import type { DataError, PaginatedResult, Query, ResourceName } from '@/data/types';
import { WIRE_STATUSES, type StatusWireRow } from '@/features/inbox/test-support';
import type { CannedResponseWire, ConversationDetail, LabelWire, MacroWire, ThreadMessage } from './types';
// ⭐ W35 / feature 040: the note wire, imported from the hook that defines it rather than restated —
// a stub answering a shape the hook does not read is the fake-more-permissive failure in miniature.
import type { PlayerNoteWire } from './use-player-notes';

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
  /** W8 — the composer's pickers. Defaults EMPTY: the buttons must not render out of nothing. */
  macros?: MacroWire[];
  canned?: CannedResponseWire[];
  /** Every `create conversation-messages` fails with this. */
  failSendWith?: DataError;
  /** The detail read fails (the thread may still answer). */
  failDetailWith?: DataError;
  /** W8 — applying a macro fails with this (the all-or-nothing refusal). */
  failMacroWith?: DataError;
  /** W10 — what the Active-tickets tab is served. */
  activeTickets?: { id: string; subject: string }[];
  /** W26 — the active-tickets read fails: the panel must SAY so, never pose as an empty list. */
  failActiveWith?: DataError;
  /** W9 — what the lookup answers, and its refusal (403 without the key, 429 over the cap). */
  lookupAnswer?: { matched: boolean; ambiguous: boolean; playerId: string; brandId: string };
  failLookupWith?: DataError;
  /** The account's brands, for the Brand chooser. Defaults to two — a chooser needs a choice. */
  brands?: { brandId: string; name: string }[];
  /**
   * ⭐ W30 — the custom-fields view (`conversation-field-view`). Defaults to NOTHING CONFIGURED
   * (no forms, no entries), under which the block renders nothing at all — so every pre-W30 case
   * keeps meaning exactly what it meant. Partial: a case states only what it is about.
   */
  fieldView?: Record<string, unknown>;
  /** The field-view read fails — the block must degrade ALONE (the TagsBlock rule). */
  failFieldViewWith?: DataError;
  /**
   * ⭐ W35 / feature 040 — the notes area on the player card.
   *
   * Defaults to an EMPTY list rather than to a refusal, so every pre-W35 case keeps meaning what it
   * meant: the area renders its empty state and nothing else changes.
   */
  notes?: PlayerNoteWire[];
  /**
   * The notes read fails with this. ⚠️ Pass `{ code: 'refused' }` for the clearance case — the area must
   * then be ABSENT, not empty, because an empty list would answer "nobody wrote anything" to a caller
   * who may not be told.
   */
  failNotesWith?: DataError;
  /**
   * What `create player-notes` answers.
   *
   * ⚠️ The stub deliberately runs **no detector of its own**. The rule lives in `@crm/common` and is
   * enforced by the server; a stub that re-implemented it would be a third copy of a security check, and
   * a stub that guessed differently from the server would make this suite lie in whichever direction it
   * guessed. So the CASE declares the outcome, exactly as the wire would carry it.
   */
  addNoteAnswer?:
    | { outcome: 'stored' }
    | { outcome: 'needs_acknowledgement'; patternKinds: string[] };
  /** `create player-notes` fails outright (a 500, a dropped connection). */
  failAddNoteWith?: DataError;
  /**
   * ⭐ 2026-08-10 — the Assignee chooser's two reads (`use-assignable-operators.ts`).
   *
   * `staff` is the AUTH list (names); `resolvedOperators` is the users translation to the
   * `Operator.id` an assignment actually points at. They are separate on purpose: the default has a
   * person present in `staff` and ABSENT from the translation, so every test runs against the
   * fail-closed case the rpc's contract describes — an inactive profile is simply not assignable.
   */
  staff?: { userId: string; email: string; displayName: string; status: string }[];
  resolvedOperators?: { operatorId: string; authUserId: string; state: string }[];
  /** The staff list fails — the chooser degrades to the read-only name, never to a broken menu. */
  failStaffWith?: DataError;
}

/** Two colleagues and a disabled one — the disabled row must never reach the chooser. */
const DEFAULT_STAFF = [
  { userId: 'u-nina', email: 'nina@example.test', displayName: 'Nina Petrova', status: 'active' },
  { userId: 'u-oleg', email: 'oleg@example.test', displayName: '', status: 'active' },
  { userId: 'u-gone', email: 'gone@example.test', displayName: 'Left Us', status: 'disabled' },
];

/**
 * ⚠️ `u-oleg` resolves and `u-nina` does too, but `u-ghost` in `staff` would not — and the reverse
 * case is covered here: `u-nina` is ACTIVE in auth while her operator profile is missing from this
 * list in the "absent ⇒ not assignable" test. The default resolves both active people.
 */
const DEFAULT_RESOLVED = [
  { operatorId: 'op-nina', authUserId: 'u-nina', state: 'online' },
  { operatorId: 'op-oleg', authUserId: 'u-oleg', state: 'away' },
];

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
  /** W10: every `list` query, so a test can assert WHICH view the rail asked for. */
  listCalls: Query[];
  /** W10: how many times the player record was read — 0 proves "asks nothing when unidentified". */
  playerReads: number;
  /** ⭐ W35: how many times the notes were read — 0 proves the same for the notes area. */
  noteReads: number;
  /**
   * 2026-08-10: the `authUserIds` each translation call asked for, in order. The chooser must ask for
   * the ids it got from the staff list and nothing else — an unbounded or invented request here would
   * be a client inventing an "all operators" question the contract does not have.
   */
  operatorLookups: string[][];
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
    listCalls: [],
    playerReads: 0,
    noteReads: 0,
    operatorLookups: [],
    async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
      stub.listCalls.push(query);
      // W10: the agent's own rail — assigned to me ∧ opened by me ∧ non-terminal.
      if (resource === 'conversations') {
        if (opts.failActiveWith) throw opts.failActiveWith;
        return page((opts.activeTickets ?? [
          { id: 'conv-active-1', subject: 'Active one' },
        ]) as unknown as T[]);
      }
      if (resource === 'conversation-statuses')
        return page((opts.statuses ?? WIRE_STATUSES) as unknown as T[]);
      if (resource === 'conversation-thread') {
        if (query.within !== detail.id) throw new Error(`thread read for wrong id: ${query.within}`);
        stub.threadReads += 1;
        return page(messages as unknown as T[]);
      }
      if (resource === 'conversation-labels') return page(labels as unknown as T[]);
      if (resource === 'labels') return page(accountLabels as unknown as T[]);
      if (resource === 'macros') return page((opts.macros ?? []) as unknown as T[]);
      if (resource === 'canned-responses') return page((opts.canned ?? []) as unknown as T[]);
      if (resource === 'brands')
        return page(
          (opts.brands ?? [
            { brandId: 'brand-a', name: 'Brand A' },
            { brandId: 'brand-b', name: 'Brand B' },
          ]) as unknown as T[],
        );
      if (resource === 'staff') {
        if (opts.failStaffWith) throw opts.failStaffWith;
        return page((opts.staff ?? DEFAULT_STAFF) as unknown as T[]);
      }
      // ⭐ W35: the notes on the card. Newest first, exactly as the server orders them.
      if (resource === 'player-notes') {
        if (opts.failNotesWith) throw opts.failNotesWith;
        stub.noteReads += 1;
        return page((opts.notes ?? []) as unknown as T[]);
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(
      resource: ResourceName,
      id: string,
      within?: string,
      filters?: Record<string, unknown>,
    ): Promise<T> {
      if (resource === 'assignable-operators') {
        const asked = String(filters?.authUserIds ?? '')
          .split(',')
          .filter(Boolean);
        stub.operatorLookups.push(asked);
        // Only what was ASKED FOR comes back — the real rpc translates a list, it does not enumerate.
        const all = opts.resolvedOperators ?? DEFAULT_RESOLVED;
        return { operators: all.filter((o) => asked.includes(o.authUserId)) } as unknown as T;
      }
      if (resource === 'conversation-detach-preview') {
        writes.push({ op: 'update', resource, id: 'preview', within });
        return { detachedPlayerId: 'p1', publicReplies: 2, privateNotes: 1 } as unknown as T;
      }
      if (resource === 'me-operator') {
        if (opts.myOperatorId === null) throw { kind: 'unavailable' };
        return { operatorId: opts.myOperatorId ?? 'op-me', active: true } as unknown as T;
      }
      // W10 — the card's two reads.
      if (resource === 'players') {
        stub.playerReads += 1;
        return { playerId: id, accountId: 'a1', brandId: 'brand-a', segment: 'standard' } as unknown as T;
      }
      if (resource === 'player-contact-summary') {
        return {
          lastInboundAt: '2026-08-05T10:00:00.000Z',
          lastOutboundAt: '',
          lastContactAt: '2026-08-05T10:00:00.000Z',
          conversationCount: 3,
          countsByStatus: [],
          channels: [{ channel: 'email', channelUnrecorded: false, lastInboundAt: '', lastOutboundAt: '', conversationCount: 3 }],
        } as unknown as T;
      }
      if (resource === 'conversations') {
        stub.detailReads += 1;
        if (opts.failDetailWith) throw opts.failDetailWith;
        if (id !== detail.id) throw { message: 'not found', retryable: false };
        return detail as unknown as T;
      }
      // ⭐ W30: the custom-fields view — resolved per caller on the real server; here, whatever the
      // case declared, over an account with nothing configured.
      if (resource === 'conversation-field-view') {
        if (opts.failFieldViewWith) throw opts.failFieldViewWith;
        return {
          formKey: '',
          entries: [],
          values: [],
          category: '',
          subCategory: '',
          classifiedBy: '',
          availableForms: [],
          ...(opts.fieldView ?? {}),
        } as unknown as T;
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(resource: ResourceName, input: unknown, within?: string): Promise<T> {
      writes.push({ op: 'create', resource, payload: input, within });
      if (resource === 'message-attachment-uploads') {
        // The WIRE shape (users.proto `Upload`): the field is `id`. The first live run failed on a
        // client reading `uploadId` — a friendlier stub would have hidden exactly that, so this one
        // answers what the server answers.
        return { id: `u-${writes.length}`, displayName: 'x.png' } as unknown as T;
      }
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
      // ⭐ W35: adding a note. The stub answers what the case declared (see `addNoteAnswer`) and runs no
      // detector of its own — and on `needs_acknowledgement` it stores NOTHING, like the server.
      if (resource === 'player-notes') {
        if (opts.failAddNoteWith) throw opts.failAddNoteWith;
        const answer = opts.addNoteAnswer ?? { outcome: 'stored' as const };
        if (answer.outcome === 'needs_acknowledgement' && (input as { acknowledged?: boolean }).acknowledged !== true) {
          return { outcome: 'needs_acknowledgement', patternKinds: answer.patternKinds } as unknown as T;
        }
        const body = (input as { body?: string }).body ?? '';
        return {
          outcome: 'stored',
          replayed: false,
          note: {
            id: `note-${writes.length}`,
            body,
            authorRef: 'auth-me',
            authorDisplayName: 'Me Myself',
            createdAt: '2026-08-13T10:00:00.000Z',
            patternKinds:
              answer.outcome === 'needs_acknowledgement' ? answer.patternKinds : [],
          },
        } as unknown as T;
      }
      throw new Error(`unexpected create: ${resource}`);
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T> {
      writes.push({ op: 'update', resource, id, payload: patch, within });
      if (resource === 'conversation-macros' && opts.failMacroWith) throw opts.failMacroWith;
      // W9: the lookup rides `update` (POST on a child singleton — the value must be in the body).
      if (resource === 'conversation-contact-lookup') {
        if (opts.failLookupWith) throw opts.failLookupWith;
        return (opts.lookupAnswer ?? {
          matched: true,
          ambiguous: false,
          playerId: 'p-found',
          brandId: 'brand-a',
        }) as unknown as T;
      }
      return {} as T;
    },
    async remove<T = void>(resource: ResourceName, id: string, within?: string): Promise<T> {
      writes.push({ op: 'remove', resource, id, within });
      // W9: a DELETE may answer with a body the caller shows — the detach warning is the first.
      if (resource === 'conversation-player') {
        return { detachedPlayerId: 'p1', publicReplies: 2, privateNotes: 1 } as unknown as T;
      }
      return undefined as T;
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
