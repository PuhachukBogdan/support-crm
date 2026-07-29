import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import {
  UI_PREFERENCE_KEYS,
  validateUiPreferencePatch,
  type UiPreferenceRejection,
} from '@crm/common';
import { UiPreferencesRepository } from './ui-preferences.repository';

/**
 * `OperatorUiPreferencesService` — an employee's own appearance settings (feature 021, roadmap 5.6).
 *
 * ⚠️ NOT `Player.preferences_json`. That is the CUSTOMER's preferences — VIP portfolio data about a
 * real human being, tier `am_only`, masked from most roles. This surface carries theme and font size:
 * cosmetic, self-owned, readable by nobody else.
 *
 * ── The subject is the caller, and that is the isolation guarantee ───────────────────────────────
 * Neither request message names a subject; the account and person come from the actor metadata the
 * gateway forwards from a validated session. So "you cannot read someone else's settings" is the
 * ABSENCE of a parameter, not a check somebody could remove — `isolation.spec.ts` asserts the
 * absence structurally rather than trusting this comment.
 *
 * ── What is deliberately NOT read from the metadata ──────────────────────────────────────────────
 * **`x-actor-permissions`** — no permission gates these operations and none is created for them.
 * ADR 0035's hard boundary: hiding something through a preference is not a restriction, and
 * revealing something through a preference cannot grant access. Reading the permission set here
 * would be the first step toward a preference that depends on one.
 *
 * **`x-actor-effective-role`** — nothing here is masked. Every caller gets every catalogue key,
 * because the values describe their own screen.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

interface UpdateWire {
  values?: Record<string, string>;
}

function readStr(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

const forbidden = (message = 'forbidden') =>
  new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message });

/**
 * ⚠️ A refusal reflects NO caller-supplied text — and the two cases differ for a reason found live.
 *
 * The obvious version of this function named the offending key in both branches, so that a settings
 * screen could highlight the wrong control. That is safe in exactly one of them:
 *
 *  • **`value-not-allowed`** — the key MATCHED the closed catalogue, so the name being echoed is a
 *    catalogue literal, not input. Naming it is useful and carries nothing the caller supplied.
 *  • **`unknown-key`** — the key is arbitrary caller input by definition. Echoing it reflects
 *    unvalidated text back through the gateway and into its logs (Principle IV), and "which unknown
 *    key" is a client bug rather than something a user can act on: a settings screen only ever sends
 *    catalogue keys. So the name is dropped, and the CLOSED, non-secret key list is offered instead —
 *    the same reasoning the upload-purpose catalogue uses when it answers an unknown purpose plainly.
 *
 * The value is never echoed in either branch.
 */
function invalidPatch(rejection: UiPreferenceRejection): RpcException {
  const message =
    rejection.reason === 'empty'
      ? 'no preferences given'
      : rejection.reason === 'unknown-key'
        ? `unknown preference; known preferences: ${UI_PREFERENCE_KEYS.join(', ')}`
        : `value not allowed for preference: ${rejection.key}`;
  return new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message });
}

interface Caller {
  accountId: string;
  authUserId: string;
  underPreview: boolean;
}

/**
 * Fail-closed on either half of the identity.
 *
 * A missing account has nothing to scope to. A missing person is subtler and matters more here than
 * anywhere else in this service: every other surface keys on a record id, but this one keys on the
 * CALLER, so an empty user id would silently address a shared row that every context-less call
 * shared. Refusing is the only safe reading.
 */
function readCaller(md: Metadata | undefined): Caller {
  const accountId = readStr(md, 'x-actor-account-id');
  if (!accountId) throw forbidden();
  const authUserId = readStr(md, 'x-actor-user-id');
  if (!authUserId) throw forbidden();
  return { accountId, authUserId, underPreview: readStr(md, 'x-is-preview') === 'true' };
}

@Controller()
export class UiPreferencesController {
  constructor(@Inject(UiPreferencesRepository) private readonly repo: UiPreferencesRepository) {}

  /**
   * ⚠️ Under a view-as preview this returns the **REAL** caller's preferences, and that is not an
   * oversight in the metadata reading — `x-actor-user-id` carries the real caller by design (only
   * the effective ROLE changes under preview). A preview changes whose data you are looking at; it
   * does not change whose eyes you are looking with.
   */
  @GrpcMethod('OperatorUiPreferencesService', 'GetOperatorUiPreferences')
  async getOperatorUiPreferences(_req: unknown, md?: Metadata) {
    const caller = readCaller(md);
    return { values: await this.repo.read(caller.accountId, caller.authUserId) };
  }

  @GrpcMethod('OperatorUiPreferencesService', 'UpdateOperatorUiPreferences')
  async updateOperatorUiPreferences(req: UpdateWire, md?: Metadata) {
    const caller = readCaller(md);

    /**
     * View-as is READ-ONLY (feature 011 US5). The gateway already refuses every mutating method
     * while a preview is active — this is the independent second tier, and it is the reason both
     * REST routes must carry `@ResolvesPermissions()`: without it `req.effective` is never populated,
     * `x-is-preview` is never forwarded, and this branch becomes unreachable while every test stays
     * green because the first tier covers the case. That is feature 016's live-only defect and
     * feature 018's `x-is-preview` defect in one place.
     */
    if (caller.underPreview) throw forbidden('read-only preview');

    // ⚠️ VALIDATE THE WHOLE PATCH BEFORE WRITING ANY OF IT (FR-005). A partially applied write is the
    // worst outcome available here: the caller gets an error and the record changed anyway.
    const result = validateUiPreferencePatch(req?.values);
    if (!result.ok) throw invalidPatch(result.rejection);

    /**
     * ⚠️ NO AUDIT ENTRY, and this is a decision rather than an omission.
     *
     * 0019/SEC-29 records SENSITIVE actions. Changing your own font size is not one, and ~58 agents
     * toggling a theme several times a day would bury the entries a reviewer actually needs — a
     * trail's value is inversely proportional to its noise. ADR 0035's boundary table has the row:
     * permissions are audited, preferences are not.
     *
     * Stated here because in this product a deliberate absence otherwise reads as an oversight to
     * the next person, who then "fixes" it.
     */
    return { values: await this.repo.apply(caller.accountId, caller.authUserId, result.entries) };
  }
}
