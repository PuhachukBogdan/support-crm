import type { DataAccess, RealtimeEvent } from '../data-access';
import type { RealtimePort } from './ws-port';
import type { Query, PaginatedResult, ResourceName } from '../types';
import { MAX_PAGE_SIZE } from '../types';
import { clientRefusal, dataErrorForStatus } from '../errors';
import { rowFor, type Operation, type RouteRow } from './registry';
import { createFetchPort, type HttpPort, type HttpResponse } from './http-port';

/**
 * T014/T015 [US1] — the real `DataAccess`, over the gateway's REST edge (feature 019, roadmap 8.4).
 *
 * ── There is NO conditional on a resource name in this file, and that is enforced ───────────────
 * Everything resource-specific is a field on a registry row. Adding a resource is adding a row;
 * `registry.structure.test.ts` fails if a branch appears here. That is what makes the operator's
 * constraint — later work ADDS, never rewrites — a property of the code rather than an intention.
 *
 * ── It passes records through untouched, deliberately ───────────────────────────────────────────
 * No defaulting, no normalising, no filling of missing fields. The server decides what a caller may
 * see, and a client-side default would reconstruct exactly the disclosure it refused to make. It
 * matters more than it looks: the live run of 2026-07-29 found the gateway already re-materialises
 * withheld fields as blanks, so the data arriving here is ALREADY lossy — adding a second layer of
 * invention on top would make "empty" completely unreadable. See `contracts/gateway-rest.md`.
 */
export class GatewayDataAccess implements DataAccess {
  constructor(
    private readonly http: HttpPort = createFetchPort(),
    /**
     * The realtime transport (feature 034, W4). **Optional, and absent means inert** — every existing
     * construction of this class (fixture ports, conformance, the recorded-response tests) keeps working
     * and simply receives no events, which is the behaviour the whole app had until now.
     */
    private readonly realtime?: RealtimePort,
  ) {}

  /**
   * Watch for *something changed*. The handler gets ids; the screen re-reads through `list`/`get`.
   *
   * ⚠️ With no transport this returns a no-op unsubscribe rather than throwing: a screen must not have to
   * ask whether realtime exists, and one that forgets to check must not break (FR-014).
   */
  subscribe(handler: (event: RealtimeEvent) => void): () => void {
    return this.realtime?.subscribe(handler) ?? (() => undefined);
  }

  async list<T = unknown>(resource: ResourceName, query: Query): Promise<PaginatedResult<T>> {
    const row = this.rowWith(resource, 'list');
    const path = this.instancePath(row, query.within);
    const res = await this.http({ path, query: this.queryFor(row, query) });
    const body = this.okBody(res) as Record<string, unknown>;

    const items = (body[row.collection] as T[] | undefined) ?? [];
    // An empty token means exhausted. Treating '' as a cursor loops forever and looks like a slow
    // list rather than a crash — the worst kind of bug to meet in a UI.
    const token = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    const nextCursor = token === '' ? null : token;

    // Derived from the cursor, never from item count: a full page is not evidence of a next one,
    // and an empty page carrying a token is legal.
    return { items, nextCursor, hasMore: nextCursor !== null };
  }

  /**
   * W10 widened this with `filters`: a single-record read may carry declared query parameters —
   * `/players/:id/contact-summary` REQUIRES `brandId`, because the same platform id under two brands
   * is two people. The allow-list is the row's, exactly as for a list: an undeclared key is refused
   * before a request exists, never sent and silently dropped.
   */
  async get<T = unknown>(
    resource: ResourceName,
    id: string,
    within?: string,
    filters?: Record<string, unknown>,
  ): Promise<T> {
    const row = this.rowWith(resource, 'get');
    const query = this.filtersFor(row, filters ?? {});
    const res = await this.http({ path: this.itemPath(row, id, within), query });
    return this.okBody(res) as T;
  }

  /**
   * W7 — the three writes, over the same rows (roadmap 9.3: the ticket window is the first screen
   * that writes). Everything verb- and path-shaped comes off the row: `row.verbs` for the
   * non-default verbs, `{within}` in `row.path` for child resources, `row.singleton` for writes
   * that take no item id. A response body is returned as-is — the server's word, not a merge.
   */
  async create<T = unknown>(resource: ResourceName, input: unknown, within?: string): Promise<T> {
    const row = this.rowWith(resource, 'create');
    const res = await this.http({ path: this.instancePath(row, within), method: 'POST', body: input });
    return this.okBody(res) as T;
  }

  async update<T = unknown>(resource: ResourceName, id: string, patch: unknown, within?: string): Promise<T> {
    const row = this.rowWith(resource, 'update');
    const method = row.verbs?.update ?? 'PATCH';
    const res = await this.http({ path: this.itemPath(row, id, within), method, body: patch });
    return this.okBody(res) as T;
  }

  async remove<T = void>(resource: ResourceName, id: string, within?: string): Promise<T> {
    const row = this.rowWith(resource, 'remove');
    const res = await this.http({ path: this.itemPath(row, id, within), method: 'DELETE' });
    // The body is returned rather than discarded: a DELETE may answer with something the caller
    // must show (W9's detach warning). A route with no body simply yields undefined.
    return this.okBody(res) as T;
  }

  /** Resolve the row and confirm the operation exists for it — a missing op fails by name. */
  private rowWith(resource: ResourceName, op: Operation): RouteRow {
    const row = rowFor(resource);
    if (!row.ops.includes(op)) this.notImplemented(resource, op);
    return row;
  }

  /**
   * W7 — the collection path, with the parent instance spliced in when the row is a CHILD
   * (`{within}` in `row.path`). Both directions refuse rather than guess: a child path without its
   * parent id is not a request, and a `within` against a non-child row is a caller error that would
   * otherwise be silently discarded — the confident-wrong-answer shape again.
   */
  private instancePath(row: RouteRow, within: string | undefined): string {
    const isChild = row.path.includes('{within}');
    if (!isChild) {
      if (within !== undefined) throw clientRefusal(`"${row.resource}" is not scoped to a parent instance`);
      return row.path;
    }
    if (!within) throw clientRefusal(`"${row.resource}" requires the parent instance id (within)`);
    return row.path.replace('{within}', encodeURIComponent(within));
  }

  /**
   * The path of ONE item. W6's singleton rule, restated once for every op: a singleton's path names
   * the whole resource — no id segment exists to append, and passing one is a programming error,
   * not a request (there is nobody else the path could name). Everything else requires the id.
   */
  private itemPath(row: RouteRow, id: string, within?: string): string {
    const base = this.instancePath(row, within);
    if (row.singleton) {
      if (id !== '') throw clientRefusal(`"${row.resource}" is a singleton and takes no id`);
      return base;
    }
    if (id === '') throw clientRefusal(`"${row.resource}" requires an id`);
    const item = `${base}/${encodeURIComponent(id)}`;
    // W14: a fixed trailing segment where the gateway names the write by what it changes.
    return row.itemSuffix ? `${item}/${row.itemSuffix}` : item;
  }

  /**
   * An operation that has no implementation yet refuses loudly and by name. A silent no-op or an
   * empty success would let a screen believe it saved something (FR-010).
   */
  private notImplemented(resource: ResourceName, op: Operation): never {
    throw clientRefusal(`"${op}" is not implemented for "${resource}" yet`);
  }

  /**
   * Translate the caller's query into the parameters THIS route accepts.
   *
   * Anything undeclared is refused before a request exists. The two consumed routes disagree about
   * an unrecognised parameter — `/players` refuses it, `/conversations` silently drops it — so
   * relying on the server would mean a stray filter is loud on one route and produces a CONFIDENT
   * WRONG ANSWER on the other. Both recorded live (E5, E6).
   */
  private queryFor(row: RouteRow, query: Query): Record<string, string> {
    if (query.sort && query.sort.length > 0) {
      throw clientRefusal('sorting is not supported by this resource');
    }

    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw clientRefusal('limit must be a positive integer');
    }
    if (query.limit > MAX_PAGE_SIZE) {
      // Refused, never clamped: a silently reduced page size teaches a caller the parameter is
      // advisory, and the next thing it sends is something worse on a path that matters.
      throw clientRefusal(`limit must not exceed ${MAX_PAGE_SIZE}`);
    }

    const out: Record<string, string> = { [row.pageSizeParam]: String(query.limit) };
    if (query.cursor) out[row.pageTokenParam] = query.cursor;

    // Feature 029 — a NAMED order, checked against what this row declares. Refused client-side for the
    // same reason as an undeclared filter: `/conversations` silently drops an unknown parameter, so an
    // order this route does not accept would come back as a confidently wrong sequence rather than an
    // error. Reading `row.orders` (never a constant) keeps the transport free of route knowledge.
    if (query.order !== undefined) {
      if (!row.orderParam || !row.orders) {
        throw clientRefusal('ordering is not supported by this resource');
      }
      if (!row.orders.includes(query.order)) {
        throw clientRefusal(`unknown order for this resource: ${query.order}`);
      }
      out[row.orderParam] = query.order;
    }

    return { ...out, ...this.filtersFor(row, query.filters ?? {}) };
  }

  /**
   * The row's declared filters, translated — the one place that decides what may reach the wire.
   * Shared by `list` and (since W10) `get`: a single-record read can require a parameter too.
   */
  private filtersFor(row: RouteRow, filters: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of Object.keys(filters)) {
      const wire = row.params[key];
      // The KEY is named, never the value — a query value can be a customer identifier (SEC-26),
      // following `services/gateway/src/players/wire.ts`.
      if (!wire) throw clientRefusal(`unknown filter for this resource: ${key}`);
      const value = filters[key];
      if (value === undefined || value === null || value === '') continue;
      out[wire] = String(value);
    }

    for (const key of row.required) {
      const wire = row.params[key]!;
      if (!out[wire]) throw clientRefusal(`${key} is required for this resource`);
    }

    return out;
  }

  /** One place turns a status into a failure class; nothing reads the body to build a message. */
  private okBody(res: HttpResponse): unknown {
    if (res.status < 200 || res.status >= 300 || res.unparseable) {
      throw dataErrorForStatus(res.unparseable ? 0 : res.status);
    }
    return res.body;
  }
}
