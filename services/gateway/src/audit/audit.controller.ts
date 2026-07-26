import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  InternalServerErrorException,
  Query,
  Req,
} from '@nestjs/common';
import { Metadata } from '@grpc/grpc-js';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import {
  AuditCursorError,
  isAuditAction,
  isAuditClass,
  actionsOfClass,
  AUDIT_ACTIONS,
  AUDIT_CLASSES,
} from '@crm/common';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { AuditFederation, AuditSourceError } from './audit.federation';

type AuditReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

/**
 * The audit read surface (feature 015, roadmap 4.8). ONE route: the log, filtered and paged.
 *
 * There is deliberately no POST / PATCH / DELETE here, and there must never be. Entries are written
 * in-process inside the transaction of the action they describe (spec Q3), and append-only means there is no
 * mutation path to expose — for anyone, including the owner. `tests/audit/append-only.spec.ts` asserts that
 * absence across every service and this gateway, because "nobody holds that permission" is a weaker promise
 * than "no such path exists".
 *
 * Reading the log is itself recorded (`audit.read`): "who went looking at who accessed what" is the same
 * accountability question one level up, and an unaudited audit reader defeats the point. ONE entry per read,
 * not one per queried source.
 */
@Controller('audit')
export class AuditController {
  constructor(@Inject(AuditFederation) private readonly federation: AuditFederation) {}

  @Get()
  @RequiresPermission('platform.audit.view')
  async list(
    @Req() req: AuditReq,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('actionClass') actionClass?: string,
    @Query('targetRef') targetRef?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('pageToken') pageToken?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // Filters are validated HERE, before any RPC. An unrecognised filter is a 400, never dropped: silently
    // ignoring it widens the query to everything, which looks like a successful search and is the opposite
    // of what the caller asked for (the feature-012 lesson).
    if (action && actionClass) {
      throw new BadRequestException('specify either action or actionClass, not both');
    }
    if (action && !isAuditAction(action)) {
      throw new BadRequestException(
        `invalid action: expected one of ${Object.keys(AUDIT_ACTIONS).join(' | ')}`,
      );
    }
    if (actionClass && !isAuditClass(actionClass)) {
      throw new BadRequestException(
        `invalid actionClass: expected one of ${AUDIT_CLASSES.join(' | ')}`,
      );
    }
    if (actionClass && isAuditClass(actionClass) && actionsOfClass(actionClass).length === 0) {
      throw new BadRequestException('actionClass has no actions');
    }
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (value && Number.isNaN(new Date(value).getTime())) {
        throw new BadRequestException(`invalid ${name}: expected an RFC3339 timestamp`);
      }
    }

    const claims = req.claims!;
    const metadata = new Metadata();
    metadata.set('x-actor-account-id', claims.accountId);
    metadata.set('x-actor-user-id', claims.userId);
    metadata.set('x-actor-permissions', (req.effective?.permissionKeys ?? []).join(','));

    const query = {
      actorUserId,
      action,
      actionClass,
      targetRef,
      from,
      to,
      pageSize: clampPageSize(pageSize),
      pageToken,
    };

    let page;
    try {
      page = await this.federation.list(query, metadata);
    } catch (err) {
      if (err instanceof AuditCursorError) throw new BadRequestException('invalid pageToken');
      if (err instanceof AuditSourceError) {
        // A source we could not read is an error, not a short page: "no entries" and "a third of the log was
        // unreachable" must never look the same to someone acting on what they see.
        throw new InternalServerErrorException('part of the audit trail is unavailable');
      }
      const rpc = err as { code?: number };
      if (rpc?.code === 3) throw new BadRequestException('invalid request');
      throw new InternalServerErrorException('upstream error');
    }

    // The `audit.read` entry is written by the AUTH source while serving this read — not here. The gateway
    // owns no database (Principle VIII), and adding a write RPC would contradict the design: entries are
    // written in-process, inside the transaction of the action they describe, so no write surface exists.
    return page;
  }
}

function clampPageSize(raw?: string): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(n, MAX_PAGE_SIZE);
}
