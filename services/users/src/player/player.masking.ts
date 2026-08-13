import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { allowedFields, canMassExportContacts, seesAmOnlyTier } from '@crm/common';

/**
 * Anti-pitching contact-field masking (feature 011, US4 / T045 — SEC-AP1). Builds the player
 * response by ALLOW-LIST from the caller's role tier, so fields the role may not see are
 * **structurally absent** from the returned object — not nulled (FR-014). Pure + stateless; the
 * tier policy lives in `@crm/common` (`field-tiers`). Applied wherever a `Player` is serialized
 * (the `UsersReadService` handlers land in Phase 5 — this is the tested unit they call).
 *
 * Under a view-as preview the caller passes the PREVIEWED role's key (resolver marks it), so the
 * card is masked exactly as that role would see it (US5).
 */
export function maskPlayer<T extends Record<string, unknown>>(
  player: T,
  roleKey: string,
  /**
   * ⭐ Feature 026 (roadmap 5.7). REQUIRED, and required is the point: the `am_only` tier is no
   * longer a property of the role alone but of the role AND this record, so every call site has to
   * answer *"is this caller attached to this player?"*. Making the parameter mandatory turns that
   * into a question the compiler asks — an optional flag would have produced zero errors and
   * narrowed nothing.
   *
   * Named rather than a bare boolean: `maskPlayer(subject, role, true)` is the kind of literal that
   * gets flipped by mistake and reads as nothing at the call site.
   */
  opts: { attachedToSubject: boolean },
): Partial<T> {
  const allowed = allowedFields(roleKey, opts);
  const out: Partial<T> = {};
  for (const key of Object.keys(player) as (keyof T & string)[]) {
    if (allowed.has(key)) out[key] = player[key];
  }
  return out;
}

/**
 * Mass-export gate (feature 011, US4 / T046 — FR-017 / SEC-AP2). A masked (linear, open-only) role
 * may not bulk-export contacts: throws PERMISSION_DENIED. Individual masked reads remain allowed +
 * audited; only the bulk path is blocked. Wired onto `ListPlayersByBrand` when it lands (Phase 5).
 */
export function assertCanMassExport(roleKey: string): void {
  if (!canMassExportContacts(roleKey)) {
    throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
  }
}

/**
 * ⭐ W35 / feature 040 — the player-notes clearance, in the module that owns *"what may this role see"*.
 *
 * A note is not a field, so it cannot be masked out of a row: it is either served or refused. The
 * decision is therefore a gate rather than an allow-list — and it is the SAME decision the `am_only`
 * tier makes about this record, asked through the policy's own predicate so no second rule exists.
 *
 * ⚠️ **It lives here rather than in the notes service on purpose.** `single-policy-path.spec.ts` names
 * this file as the one place clearance is computed, and a gate written next to the query it guards is
 * exactly how feature 011 ended up with two audit stores: the second surface found writing its own
 * check easier than routing through the existing one, and nothing failed.
 *
 * ⚠️ `attachedToSubject` must come from the ONE attachment read (`AssignmentService.activeFor`), never
 * from a second query with its own idea of "attached" — the same requirement `maskPlayer` states one
 * function up, for the same reason.
 */
export function canReadPlayerNotes(
  roleKey: string,
  opts: { attachedToSubject: boolean },
): boolean {
  return seesAmOnlyTier(roleKey, opts);
}

/**
 * The refusal, spelled the way every other refusal in this service is: `PERMISSION_DENIED`, message
 * `forbidden`, and **nothing about the notes** — not their number, not whether any exist.
 *
 * "How many notes does this customer have" is itself withheld: a count would answer a question about a
 * customer to somebody who may not read the answer, which is the shape SEC-AP2 is about one size down.
 */
export function assertCanReadPlayerNotes(
  roleKey: string,
  opts: { attachedToSubject: boolean },
): void {
  if (!canReadPlayerNotes(roleKey, opts)) {
    throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
  }
}
