import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { AuthAccessGuard } from '../security/permission.guard';
import { RequiresAuthPermission } from '../security/requires-auth-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { ApiKeysService } from './api-keys.service';
import type { ApiKeyRow } from './api-keys.repository';

/** The permission the whole surface rides. See the class banner for why it is not a new key. */
export const API_KEYS_PERMISSION = 'platform.settings.manage';

interface IssueWire {
  consumer?: string;
  ipAllowList?: string[];
  ratePerHour?: number;
}
interface KeyIdWire {
  keyId?: string;
}

/**
 * ⚠️ The wire shape of a key — and the thing to notice is what is ABSENT. There is no `value` member
 * in proto `ApiKey` and none here, so a list or a read cannot leak a credential through a forgotten
 * filter; the absence is the protection, not a redaction step somebody has to remember (ADR 0043 §5).
 */
const toWire = (k: ApiKeyRow) => ({
  id: k.id,
  consumer: k.consumer,
  fingerprint: k.fingerprint,
  ipAllowList: k.ip_allow_list ?? [],
  ratePerHour: k.rate_per_hour,
  active: k.active,
  lastUsedAt: k.last_used_at ? k.last_used_at.toISOString() : '',
  createdAt: k.created_at ? k.created_at.toISOString() : '',
  rotatedFromId: k.rotated_from_id ?? '',
});

/**
 * ⭐ W31 (roadmap 3.17) — the API-key admin surface: list, issue, rotate, revoke.
 *
 * ── `platform.settings.manage`, and not a new key ────────────────────────────────────────────────
 * Issuing an integration credential is the same class of act as configuring a channel — the channels
 * and statuses surfaces already ride this key, and one key per scope stops meaning anything once
 * every screen invents its own. The proto says the same thing above these four rpcs.
 *
 * ── The second tier is the real one ──────────────────────────────────────────────────────────────
 * The gateway checks the key on the route; {@link AuthAccessGuard} checks it again here from the
 * forwarded permission context (Principle II / FR-004). A hidden button proves nothing about a
 * crafted request, and this credential mints staff accounts (SEC-PV1).
 *
 * ⚠️ `IssuedApiKey` — returned by exactly two of these handlers — is the ONE message in the product
 * that carries a key value. Nothing is logged in this module; there is no logger to leak through.
 */
@Controller()
@UseGuards(AuthAccessGuard)
export class ApiKeysGrpcController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @GrpcMethod('AuthService', 'ListApiKeys')
  @RequiresAuthPermission(API_KEYS_PERMISSION)
  async listApiKeys(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.keys.list(ctx.accountId);
    return { keys: rows.map(toWire) };
  }

  @GrpcMethod('AuthService', 'IssueApiKey')
  @RequiresAuthPermission(API_KEYS_PERMISSION)
  async issueApiKey(req: IssueWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const outcome = await this.keys.issue(ctx.accountId, ctx.userId, {
      consumer: req?.consumer ?? '',
      ipAllowList: req?.ipAllowList ?? [],
      ratePerHour: req?.ratePerHour ?? 0,
    });
    if (outcome.status === 'invalid') {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid consumer' });
    }
    if (outcome.status === 'consumer_taken') {
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'this consumer already holds an active key',
      });
    }
    return { key: toWire(outcome.issued.key), value: outcome.issued.value };
  }

  @GrpcMethod('AuthService', 'RotateApiKey')
  @RequiresAuthPermission(API_KEYS_PERMISSION)
  async rotateApiKey(req: KeyIdWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const outcome = await this.keys.rotate(ctx.accountId, ctx.userId, (req?.keyId ?? '').trim());
    if (outcome.status === 'not_found') {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    if (outcome.status === 'already_revoked') {
      // Named rather than folded into NOT_FOUND: the admin's next act is «issue», and a 404 would
      // send them looking for a key that is sitting in front of them, revoked.
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'a revoked key is re-armed by issuing, not by rotating',
      });
    }
    return { key: toWire(outcome.issued.key), value: outcome.issued.value };
  }

  @GrpcMethod('AuthService', 'RevokeApiKey')
  @RequiresAuthPermission(API_KEYS_PERMISSION)
  async revokeApiKey(req: KeyIdWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const outcome = await this.keys.revoke(ctx.accountId, ctx.userId, (req?.keyId ?? '').trim());
    if (outcome.status === 'not_found') {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    // `revoked: false` = it was already revoked. A repeat is a no-op, not an error (contract §C).
    return { revoked: outcome.revoked };
  }
}
