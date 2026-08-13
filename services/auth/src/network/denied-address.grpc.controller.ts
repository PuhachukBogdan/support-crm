import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { AuthAccessGuard } from '../security/permission.guard';
import { RequiresAuthPermission } from '../security/requires-auth-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { DeniedAddressService } from './denied-address.service';
import type { DeniedAddressRow } from './denied-address.repository';

/** The permission the whole administrative surface rides — the api-keys/channels/statuses key. */
export const DENIED_ADDRESS_PERMISSION = 'platform.settings.manage';

interface AddWire {
  address?: string;
  note?: string;
}
interface IdWire {
  id?: string;
}

/** The NORMALISED address travels, never the raw one — the screen must show what actually compares. */
const toWire = (row: DeniedAddressRow) => ({
  id: row.id,
  address: row.address,
  note: row.note ?? '',
  createdBy: row.created_by,
  createdAt: row.created_at ? row.created_at.toISOString() : '',
});

/**
 * ⭐ W32 / feature 039 (roadmap 12.10) — the deny-list an administrator manages: list, add, remove.
 *
 * ── `platform.settings.manage`, and not a new key ────────────────────────────────────────────────
 * Banning an address is the same class of act as configuring a channel or issuing an integration
 * credential, and those surfaces already ride this key. One key per screen stops meaning anything
 * once every screen invents its own.
 *
 * ── The second tier is the real one ──────────────────────────────────────────────────────────────
 * The gateway checks the key on the route; {@link AuthAccessGuard} checks it again here from the
 * forwarded permission context (Principle II). A hidden button proves nothing about a crafted
 * request — and this list decides who can reach the product at all.
 *
 * ⚠️ Identity comes from the forwarded METADATA, never from the request body. The proto messages
 * carry `caller_account_id` / `caller_user_id` for the group surface's older shape; they are
 * deliberately not read here, because a crafted request would then choose whose list it edits.
 *
 * There is no logger in this module — addresses pass through it (the `api-keys/` precedent).
 */
@Controller()
@UseGuards(AuthAccessGuard)
export class DeniedAddressGrpcController {
  constructor(@Inject(DeniedAddressService) private readonly denied: DeniedAddressService) {}

  @GrpcMethod('AuthService', 'ListDeniedAddresses')
  @RequiresAuthPermission(DENIED_ADDRESS_PERMISSION)
  async listDeniedAddresses(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.denied.list(ctx.accountId);
    return { addresses: rows.map(toWire) };
  }

  @GrpcMethod('AuthService', 'AddDeniedAddress')
  @RequiresAuthPermission(DENIED_ADDRESS_PERMISSION)
  async addDeniedAddress(req: AddWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const outcome = await this.denied.add(ctx, req?.address ?? '', req?.note ?? '');
    if (outcome.status === 'invalid') {
      // One refusal for every unstorable shape — blank, malformed, a range, an over-long note. The
      // message names the constraint and never echoes what arrived.
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'expected a single IPv4 or IPv6 address (no ranges or masks)',
      });
    }
    // ⚠️ `created: false` is a SUCCESS: the address was already listed. Never ALREADY_EXISTS — the
    // administrator expressed the same intent twice and the list says what they wanted it to say.
    return { address: toWire(outcome.row), created: outcome.created };
  }

  @GrpcMethod('AuthService', 'RemoveDeniedAddress')
  @RequiresAuthPermission(DENIED_ADDRESS_PERMISSION)
  async removeDeniedAddress(req: IdWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    // `removed: false` = it was already gone. A repeat is a no-op, not a 404: the state the caller
    // asked for is the state they got.
    return this.denied.remove(ctx, req?.id ?? '');
  }
}

/**
 * ⭐ The machine half, on the MAINTENANCE surface — the deployment-wide union the boundary compares
 * against (research D4).
 *
 * ── Why it is a separate controller rather than a fourth method above ───────────────────────────
 * The class above carries `@UseGuards(AuthAccessGuard)`, whose whole job is a permission key. This
 * rpc has no permission to check and must never acquire one: the caller is the gateway's cache
 * refresh, which holds a machine context and no session. Keeping it in its own class means the
 * ACTOR-KIND gate is the visible and only gate on it, and no future edit can leave it relying on a
 * class-level decorator that was written for a different question.
 *
 * ⛔ There is no route to this method and there must never be one, exactly as with the offboarding
 * sweep beside it (`provisioning/staff-sweep.grpc.controller.ts`, whose shape this follows).
 *
 * ⚠️ It answers ADDRESSES ONLY — no id, no note, no author, no account. A caller learns that a string
 * is banned somewhere in the deployment and nothing about whose list it sits on.
 */
@Controller()
export class DeniedAddressEdgeController {
  constructor(@Inject(DeniedAddressService) private readonly denied: DeniedAddressService) {}

  /**
   * ⚠️ `AuthService`, not the maintenance surface. It was drafted there and
   * `tests/worker/maintenance-ticks.spec.ts` refused it, correctly: a maintenance rpc in this product
   * means «only a tick may call it», and this one is read by the GATEWAY on a timer. It belongs
   * beside `ValidateToken` — infrastructure the gateway asks auth for, on no session.
   *
   * The gate stays the actor KIND, which no breadth of permission satisfies: there is no session at
   * the moment the boundary decides, so there is no permission to check.
   */
  @GrpcMethod('AuthService', 'ListDeniedAddressesForEdge')
  async listDeniedAddressesForEdge(_req: unknown, metadata: Metadata) {
    // The same gate as every maintenance rpc in the product: the actor KIND, which no breadth of
    // permission satisfies.
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    return { addresses: await this.denied.listForEdge() };
  }
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}
