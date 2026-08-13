import { Inject, Injectable, Logger } from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import { arraySink, hasPermission, scopeOf, type ExportScopeName } from '@crm/common';
import { AuditRepository } from '../audit/audit.repository';
import { AuthorAuthorityClient, AuthorityUnavailableError } from '../auth/auth.client';
import { UploadsClient, UploadsUnavailableError } from '../uploads/uploads.client';
import { errorLabel } from './error-label';
import {
  ExportProducer,
  ByteLimitExceededError,
  RowLimitExceededError,
  type ExportFilterSet,
} from './export.producer';
import { ExportQuota } from './export.quota';
import { ExportRepository, type ExportJobRow } from './export.repository';

/** The upload purpose an export artefact is stored through — a row in the 016 catalogue. */
const EXPORT_PURPOSE = 'conversation_export';

export class UnknownScopeError extends Error {
  constructor() {
    super('unknown export scope');
    this.name = 'UnknownScopeError';
  }
}
export class ExportForbiddenError extends Error {
  constructor() {
    super('forbidden');
    this.name = 'ExportForbiddenError';
  }
}

export interface CreateExportArgs {
  accountId: string;
  requestedBy: string;
  permissions: readonly string[];
  scopeName: string;
  filters: ExportFilterSet;
  /** The filter values as given, stored for the status view — NEVER audited, NEVER logged. */
  rawFilters: Record<string, unknown>;
}

/**
 * Export orchestration (feature 017, US1 — roadmap 4.10).
 *
 * Two entry points, and the split matters: `create` runs inside the requester's call and does every
 * check that can refuse cheaply; `run` happens later, in a worker-triggered tick, and is where the
 * artefact is produced, stored and recorded.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    @Inject(ExportRepository) private readonly repo: ExportRepository,
    @Inject(ExportProducer) private readonly producer: ExportProducer,
    @Inject(ExportQuota) private readonly quota: ExportQuota,
    @Inject(UploadsClient) private readonly uploads: UploadsClient,
    @Inject(AuthorAuthorityClient) private readonly authority: AuthorAuthorityClient,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * Accept a request, or refuse it having written NOTHING.
   *
   * Order is the design (the same "all-or-nothing by ordering, not rollback" that features 013 and 014
   * settled on): unknown scope → permission → quota, and only then the insert. A refused request
   * therefore queues no job, stores no bytes and — because nothing was exported — writes no audit
   * entry (FR-021).
   */
  async create(args: CreateExportArgs, now: Date): Promise<ExportJobRow> {
    const scope = scopeOf(args.scopeName);
    if (!scope) throw new UnknownScopeError();

    // The service tier checks independently of the gateway (Principle II / SEC-17). Two tiers, same
    // decision — which is what makes bypassing the gateway pointless rather than merely discouraged.
    if (!hasPermission(args.permissions, scope.permission)) throw new ExportForbiddenError();

    await this.quota.assertWithinQuota(args.accountId, args.requestedBy, scope, now);

    return this.repo.create(args.accountId, {
      scope: args.scopeName as ExportScopeName,
      format: scope.format,
      requestedBy: args.requestedBy,
      filters: args.rawFilters,
      expiresAt: new Date(now.getTime() + scope.ttlSeconds * 1000),
    });
  }

  /**
   * Produce, store, and record one claimed export.
   *
   * The ordering here is forced by two facts that cannot both be inside a database transaction: a gRPC
   * call to store bytes, and a row transition that must share a transaction with its audit entry. So:
   *
   *   1. re-resolve the requester's CURRENT authority (R15) — refuse if it is gone;
   *   2. produce into a sink, refusing on either cap;
   *   3. store the artefact through the existing `CreateUpload`;
   *   4. ONE transaction: mark `ready` + write `export.create`.
   *
   * A stored artefact whose step-4 transaction then fails leaves an ORPHAN upload — which its own
   * `expires_at` purges within the window. That is the deliberate trade: wasted storage beats data loss,
   * the same choice feature 016 made for claim-before-write.
   */
  async run(row: ExportJobRow, now: Date): Promise<'completed' | 'failed'> {
    const scope = scopeOf(row.scope);
    if (!scope) {
      // A row naming a scope the catalogue no longer has cannot be produced. Fail it loudly rather than
      // guessing a substitute.
      await this.repo.fail(row.account_id, row.id, 'source_unavailable', now);
      return 'failed';
    }

    let permissions: readonly string[];
    try {
      const resolved = await this.authority.resolve(row.account_id, row.requested_by);
      permissions = resolved.permissionKeys;
    } catch (err) {
      // Authority could not be ESTABLISHED (auth unreachable / unreadable) — distinct from "the user no
      // longer holds it". Both refuse; neither proceeds on an assumption.
      await this.repo.fail(
        row.account_id,
        row.id,
        err instanceof AuthorityUnavailableError ? 'source_unavailable' : 'source_unavailable',
        now,
      );
      return 'failed';
    }

    /**
     * The R15 check, and the reason this feature has an `authority_revoked` failure code.
     *
     * The permission was verified when the request was accepted. Between then and now, Access
     * Management may have revoked it — feature 011's copy-on-write path makes that a normal operation.
     * Producing the file anyway would mean acting on authority nobody currently has, so the export
     * fails instead. The requester sees a terminal status with a reason, not a file.
     */
    if (!hasPermission(permissions, scope.permission)) {
      await this.repo.fail(row.account_id, row.id, 'authority_revoked', now);
      return 'failed';
    }

    const sink = arraySink();
    try {
      const produced = await this.producer.produce(
        row.account_id,
        scope,
        this.filtersOf(row),
        sink,
      );

      const stored = await this.uploads.createUpload(
        EXPORT_PURPOSE,
        this.filenameFor(row),
        Buffer.from(sink.value(), 'utf8'),
        'text/csv',
        this.actorMetadata(row, permissions),
      );

      /**
       * ONE transaction: the row becomes `ready` and the entry exists, or NEITHER happens (FR-020).
       *
       * Its own try/catch, and the reason is the failure CODE. Everything above this point fails because
       * the export could not be produced; this fails because it could not be RECORDED — the artefact
       * exists and is deliberately abandoned rather than served unaudited. Folding that into the outer
       * handler would report `source_unavailable` and send an operator to the database, which is the
       * one failure in this feature whose diagnosis must not be guesswork.
       *
       * `statement()` validates the entry BEFORE the transaction opens, so an inexpressible detail is a
       * refusal rather than a rollback — and lands here, correctly, as `record_failed`.
       */
      try {
        await this.repo.runInTransaction([
          this.repo.completeStatement(
            row.account_id,
            row.id,
            { rowCount: produced.rowCount, byteSize: produced.byteSize, uploadId: stored.uploadId },
            now,
          ),
          this.audit.statement(row.account_id, {
            action: 'export.create',
            actorUserId: row.requested_by,
            targetRef: row.id,
            // The class's allow-list is exactly these three keys. A filter value, a row value or a
            // filename is INEXPRESSIBLE here — rejected by `parseDetail`, not omitted by convention.
            detail: { format: row.format, rowCount: produced.rowCount, scope: row.scope },
          }),
        ]);
      } catch (err) {
        await this.repo.fail(row.account_id, row.id, 'record_failed', now);
        this.logger.warn(`export ${row.id} produced but NOT recorded — refused: ${errorLabel(err)}`);
        return 'failed';
      }
      return 'completed';
    } catch (err) {
      await this.repo.fail(row.account_id, row.id, this.reasonFor(err), now);
      /**
       * `errorLabel`, not `err.message`.
       *
       * Feature 014's live lesson was that a bare class name made a failing sweep undiagnosable, and that
       * lesson holds — but its conclusion does not transfer unchanged to this path. The producer runs a
       * FILTERED query, and the filter values are the sensitive part: a Prisma or driver error can echo
       * the query arguments into its message, so "log the message" would mean "log the filters" on
       * exactly the path somebody reads when something has gone wrong.
       *
       * So messages are logged for the errors this product defines and class names for everything else
       * (see `error-label.ts`). The export ID is fine and is what makes the line useful — a
       * system-generated uuid, not a tenant value.
       */
      this.logger.warn(`export ${row.id} failed: ${errorLabel(err)}`);
      return 'failed';
    }
  }

  private reasonFor(err: unknown) {
    if (err instanceof RowLimitExceededError) return 'row_limit_exceeded' as const;
    if (err instanceof ByteLimitExceededError) return 'byte_limit_exceeded' as const;
    if (err instanceof UploadsUnavailableError) return 'storage_unavailable' as const;
    // A refusal from `users` (a gRPC status) is also a storage failure from this side: the bytes did not
    // land, so there is nothing to reference and nothing to audit.
    if (typeof (err as { code?: number })?.code === 'number') return 'storage_unavailable' as const;
    return 'source_unavailable' as const;
  }

  /**
   * Actor metadata for the store call — the requester's identity plus their FRESHLY RESOLVED permissions.
   *
   * This is the wire feature 016's live defect was on: `users` reads `x-actor-permissions` from metadata,
   * so an empty value means every export is correctly refused. Both tiers would be individually right
   * and the export would still never work.
   */
  private actorMetadata(row: ExportJobRow, permissions: readonly string[]): Metadata {
    const md = new Metadata();
    md.set('x-actor-account-id', row.account_id);
    md.set('x-actor-user-id', row.requested_by);
    md.set('x-actor-permissions', permissions.join(','));
    return md;
  }

  /**
   * Filters for production, read back from the stored row.
   *
   * The values were DECODED before storage (DB scalars, not wire enum names), so this reads them as-is.
   * That ordering is deliberate: a second decode step here would be a second place to forget one, which
   * is exactly the omission Track B found on the request side.
   *
   * `slaOutcome` is passed through as the outcome; the producer resolves it into an id set at production
   * time, as the list does when it reads.
   */
  private filtersOf(row: ExportJobRow): ExportFilterSet {
    const raw = (row as unknown as { filters_json?: Record<string, unknown> }).filters_json ?? {};
    const out: ExportFilterSet = {};
    // Feature 032: a LIST of status keys, resolved at the edge from `status_key` / `status_category`. An
    // empty array is stored and read faithfully — it means "no configured status satisfies the ask", and
    // dropping it here would turn a deliberately empty export into an export of everything.
    if (Array.isArray(raw.statusIn)) out.statusIn = raw.statusIn as string[];
    if (typeof raw.priority === 'string') out.priority = raw.priority;
    if (typeof raw.assigneeOperatorId === 'string') out.assigneeOperatorId = raw.assigneeOperatorId;
    if (typeof raw.playerId === 'string') out.playerId = raw.playerId;
    if (Array.isArray(raw.brandIn)) out.brandIn = raw.brandIn as string[];
    if (Array.isArray(raw.idIn)) out.idIn = raw.idIn as string[];
    if (typeof raw.slaOutcome === 'string') out.slaOutcome = raw.slaOutcome;
    // Feature 029. ⚠️ THIS is the hop where `slaOutcome` was once missing, so a request for breached
    // conversations produced every conversation — accepted at the edge, stored, then dropped on the way
    // to the query. A channel filter forgotten here fails the same way and in the same direction: a file
    // with MORE customer rows than the caller asked for, which looks like a correct answer.
    if (typeof raw.channel === 'string') out.channel = raw.channel;
    // W5: same hop, same hazard, for the rail filter. (The plural categories need no line here — the
    // edge resolves them into `statusIn` before anything is stored.)
    if (typeof raw.openedByOperatorId === 'string') out.openedByOperatorId = raw.openedByOperatorId;
    // ⭐ W24: same hop, same hazard — a search accepted at the edge and dropped here exports MORE
    // customer rows than the screen showed, in the direction that looks like a correct answer.
    if (typeof raw.search === 'string') out.search = raw.search;
    // ⭐ W27 / 036: mirrored like every list filter — the parity guard (FR-027) is right and the
    // first draft's "exports never see shelved" was the inverted half of the same lie: a supervisor
    // exporting the Suspended bucket would have received a file with NONE of the rows on screen.
    // The permission travelled with the filter at the accepting edge; absent = the exclusion default
    // (the producer rides the same repository list).
    if (typeof raw.shelved === 'string') out.shelved = raw.shelved as ExportFilterSet['shelved'];
    return out;
  }

  /**
   * The display label.
   *
   * Derived from the SCOPE and the date — never from anything a user typed, and never containing a
   * filter value. A filename travels with the file and is echoed by browsers and mail clients, so a
   * filter term inside it would be a PII leak with a very long tail (SEC-26).
   */
  private filenameFor(row: ExportJobRow): string {
    const day = row.created_at.toISOString().slice(0, 10);
    return `${row.scope}-${day}.csv`;
  }
}
