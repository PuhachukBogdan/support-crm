import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { OperatorProfileService } from './operator-profile.service';

/**
 * `OperatorProfileService.EnsureOwnOperator` — the join nobody owned (roadmap 5.10, MVP block W1).
 *
 * A separate gRPC service from `UsersReadService` because a write on a service named *Read* is a lie
 * in the contract and `tests/users-read/no-outbound.spec.ts` enforces it. New service, EXISTING
 * package, so no new hosting entry is required — a claim `hosting.spec.ts` verifies rather than
 * assumes (feature 015's one live-only defect was a hosted package whose handler was never wired).
 *
 * ⭐ **NO PERMISSION IS CHECKED HERE, and that is the design rather than an omission.** Every other
 * write in this service checks `x-actor-permissions`, so the absence needs its reason stated: the
 * subject of this call is the caller themselves, taken from the validated context and impossible to
 * point at anyone else. Requiring a permission would mean a newly registered person cannot obtain
 * their own profile until an administrator grants them something — and the profile is precisely what
 * they need before an administrator can do anything WITH them. The capability is "exist", and a
 * signed-in human being is already permitted to exist.
 *
 * ⚠️ **Identity comes from metadata, never from the message.** If either header is missing the call
 * is refused — a blank subject would key a row on an empty string, i.e. one shared ownerless profile
 * handed to every caller whose context failed to arrive.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/** Empty by contract — the subject is the caller and no name is knowable here. See the .proto. */
type EnsureWire = Record<string, never>;

@Controller()
export class OperatorProfileController {
  constructor(@Inject(OperatorProfileService) private readonly svc: OperatorProfileService) {}

  @GrpcMethod('OperatorProfileService', 'EnsureOwnOperator')
  async ensureOwnOperator(_req: EnsureWire, md?: Metadata) {
    const accountId = readStr(md, 'x-actor-account-id');
    const authUserId = readStr(md, 'x-actor-user-id');

    // NULL, not a guessed name: `auth.User.display_name` is the authoritative one and the browser
    // composes a person's name from the read that owns it (the pattern feature 029 established).
    const profile = await this.svc.ensureOwn(accountId, authUserId, null);

    return {
      operatorId: profile.operatorId,
      accountId: profile.accountId,
      displayName: profile.displayName ?? '',
      active: profile.active,
    };
  }
}
