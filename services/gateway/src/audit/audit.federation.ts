import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import { Metadata } from '@grpc/grpc-js';
import {
  decodeComposite,
  mergePages,
  type CompositeCursor,
  type MergeableEntry,
  type SourceResult,
} from '@crm/common';
import { AUTH_CLIENT, CHATS_CLIENT, USERS_CLIENT } from '../grpc/clients.module';

/** One entry as it comes off the wire. Only id/createdAt/source matter to the merge. */
export interface WireAuditEntry extends MergeableEntry {
  actorUserId: string;
  actorKind: string;
  actorRef: string;
  underPreview: boolean;
  action: string;
  targetRef: string;
  detailJson: string;
}

interface AuditPageWire {
  entries: WireAuditEntry[];
  nextPageToken: string;
}

interface AuditReadGrpc {
  listAuditEntries(d: Record<string, unknown>, md?: Metadata): Observable<AuditPageWire>;
}

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  actionClass?: string;
  targetRef?: string;
  from?: string;
  to?: string;
  pageSize: number;
  pageToken?: string;
}

/** A source that could not be read. Surfaced, never silently omitted (see below). */
export class AuditSourceError extends Error {
  constructor(readonly source: string) {
    super(`audit source unavailable: ${source}`);
    this.name = 'AuditSourceError';
  }
}

/**
 * The federated audit read (feature 015, research R2).
 *
 * The trail is one logical log living in three databases — an entry must be written inside the transaction of
 * the action it describes (spec Q3), and a cross-service database write is forbidden (Principle VIII). A
 * reader wants one ordered list, so composing the sources is a READ-side job, and it belongs here: the
 * gateway is allowed to compose, it is only forbidden to hold business logic (Principle VIII).
 *
 * ── A failed source is an ERROR, not a short page ───────────────────────────────────────────────────
 * If users is down, this throws rather than returning auth + chats and calling it the log. An audit reader
 * acting on a page they believe is complete is exactly the failure this feature exists to prevent: "no
 * entries for that user" and "one third of the log was unreachable" must never look the same.
 */
@Injectable()
export class AuditFederation implements OnModuleInit {
  private sources!: Array<{ name: string; svc: AuditReadGrpc }>;

  constructor(
    @Inject(AUTH_CLIENT) private readonly auth: ClientGrpc,
    @Inject(USERS_CLIENT) private readonly users: ClientGrpc,
    @Inject(CHATS_CLIENT) private readonly chats: ClientGrpc,
  ) {}

  onModuleInit(): void {
    this.sources = [
      { name: 'auth', svc: this.auth.getService<AuditReadGrpc>('AuthService') },
      { name: 'users', svc: this.users.getService<AuditReadGrpc>('UsersReadService') },
      { name: 'chats', svc: this.chats.getService<AuditReadGrpc>('ChatsReadService') },
    ];
  }

  /** One ordered page across every source, plus the composite cursor for the next request. */
  async list(query: AuditQuery, metadata: Metadata) {
    // A malformed token throws here rather than silently restarting from the top — a reader who believes
    // they are on page 4 must not be handed page 1 with entries that look like duplicates.
    const incoming: CompositeCursor = decodeComposite(query.pageToken);
    const first = Object.keys(incoming).length === 0;

    const results: SourceResult<WireAuditEntry>[] = [];
    for (const source of this.sources) {
      // A source absent from a non-first cursor is exhausted; do not query it again.
      if (!first && incoming[source.name] === undefined) {
        results.push({ source: source.name, entries: [], nextPageToken: '' });
        continue;
      }
      const page = await this.read(source, query, incoming[source.name] ?? '', metadata);
      results.push({
        source: source.name,
        // Defensive: stamp the source even if a service omitted it, since the merge keys on it.
        entries: (page.entries ?? []).map((e) => ({ ...e, source: source.name })),
        nextPageToken: page.nextPageToken ?? '',
      });
    }

    return mergePages(results, query.pageSize, incoming);
  }

  private async read(
    source: { name: string; svc: AuditReadGrpc },
    query: AuditQuery,
    pageToken: string,
    metadata: Metadata,
  ): Promise<AuditPageWire> {
    try {
      return await firstValueFrom(
        source.svc.listAuditEntries(
          {
            actorUserId: query.actorUserId ?? '',
            action: query.action ?? '',
            actionClass: query.actionClass ?? '',
            targetRef: query.targetRef ?? '',
            from: query.from ?? '',
            to: query.to ?? '',
            pageToken,
            pageSize: query.pageSize,
          },
          metadata,
        ),
      );
    } catch (err) {
      // Rethrown with the source named. The caller maps it to a 5xx; what must NOT happen is returning the
      // other two sources' rows as though they were the whole trail.
      const rpc = err as { code?: number };
      if (rpc?.code === 3 || rpc?.code === 7 || rpc?.code === 16) throw err; // client/permission errors pass through
      throw new AuditSourceError(source.name);
    }
  }
}
