import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { ProvisioningRepository } from './provisioning.repository';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §3/§4) — the first step of the offboarding sweep.
 *
 * ── Why an offboarding needs a sweep at all ─────────────────────────────────────────────────────
 * Closing an account is only ONE THIRD of it. The account lives here, the operator flag lives in
 * users, and the open work lives in chats — and no service holds a client to the next one. The
 * worker holds all three, so the sweep is a job there, and this rpc is what it asks first.
 *
 * ── Why there is no «handled» flag, and no second table ─────────────────────────────────────────
 * The obvious design is a queue of pending offboardings that rows leave once processed. It was not
 * built, because both follow-up calls are already idempotent by predicate: setting an inactive
 * operator inactive reports `unchanged`, and returning already-moved work to the backlog matches
 * nothing and reports `moved: 0`. A sweep made of no-ops needs no bookkeeping to stay correct — and
 * a flag that says «handled» is exactly the thing that goes stale and lies after one failed run.
 *
 * ⚠️ **The window is what bounds this, not a status flag.** Everyone disabled inside it is re-checked
 * every tick; the cost is two indexed queries per person that return nothing. Outside the window a
 * person has been swept hundreds of times already, so re-reading them for ever buys nothing — which
 * is why «disabled long ago» leaves the set by age rather than by a claim that the work is done.
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_BATCH = 200;

@Controller()
export class StaffSweepController {
  constructor(@Inject(ProvisioningRepository) private readonly repo: ProvisioningRepository) {}

  @GrpcMethod('AuthMaintenanceService', 'ListDisabledStaff')
  async listDisabledStaff(req: { limit?: number; withinDays?: number }, metadata: Metadata) {
    // The same gate as every maintenance rpc in the product: the actor KIND, which no breadth of
    // permission satisfies. There is no route to this method and there must never be one — a list of
    // recently-offboarded colleagues is a staffing fact, not a page.
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const limit = Math.min(Math.max(Number(req?.limit ?? 0) || 50, 1), MAX_BATCH);
    const days = Math.min(Math.max(Number(req?.withinDays ?? 0) || DEFAULT_WINDOW_DAYS, 1), 365);
    const since = new Date(Date.now() - days * 86_400_000);
    const staff = await this.repo.listDisabledStaff(since, limit);
    return { staff: staff.map((s) => ({ accountId: s.accountId, userId: s.userId })) };
  }

  /**
   * ⭐ W32 (roadmap 3.16, ADR 0043 §4) — every desk of one account and who answers for it.
   *
   * The sweep's second question. It asks for ALL desks rather than only the departing person's: an
   * account has a handful, this runs once per offboarding, and the alternative — ask chats which
   * desks the work sits on, then ask here about those — spends a round trip to learn less.
   *
   * ⚠️ Answers `leadUserId` as an **auth** user id, because that is what it is. The translation to
   * the profile id chats assigns by happens in the worker, in the one place that translation lives —
   * W31's most expensive lesson was a draft that let those two id spaces meet by accident.
   */
  @GrpcMethod('AuthMaintenanceService', 'ListDeskLeads')
  async listDeskLeads(req: { accountId?: string }, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    // A machine has no account of its own — it is in the request, like every maintenance call here.
    const accountId = String(req?.accountId ?? '').trim();
    if (!accountId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'account_id is required',
      });
    }
    const desks = await this.repo.listDeskLeads(accountId);
    return { desks };
  }
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}
