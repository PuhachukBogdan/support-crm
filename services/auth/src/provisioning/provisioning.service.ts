import { Inject, Injectable } from '@nestjs/common';
import { InviteService } from '../auth/invite.service';
import { RefreshService } from '../auth/refresh.service';
import { AuditRepository } from '../audit/audit.repository';
import { ProvisioningRepository } from './provisioning.repository';
import {
  hashEmployeeId,
  REFUSAL_STATUS,
  REFUSAL_TYPE,
  type ApiKeyFacts,
  type ProvisioningRefusal,
} from './provisioning.verify';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043): what happens AFTER the gate said yes.
 *
 * Two operations and only two (§1). Everything else about a colleague — their role, their
 * permissions, their groups — stays inside Access Management, where a human with a session does it.
 *
 * ⚠️ **The administrator bar applies in BOTH directions.** Create cannot mint one (structurally —
 * `createProvisioningInvitation` has no role parameter), and delete cannot touch one either: an HR
 * platform that fires a termination event for an administrator's email must not be able to close the
 * account that could have stopped it. SEC-PV1 words the first half; the second half is the same
 * sentence read backwards, and leaving it out would make «the key cannot touch an admin» false.
 */

export interface ProvisioningOutcome {
  statusCode: number;
  problemType: string;
  outcome: string;
  bodyJson: string;
}

/** Roles a machine may never create, touch or close. Read from the target's own bindings. */
const PRIVILEGED_ROLES = new Set(['admin', 'super_admin']);

const problem = (type: string, title: string, status: number, detail: string, instance: string) =>
  JSON.stringify({
    type: `https://crm.local/problems/${type}`,
    title,
    status,
    detail,
    instance,
  });

@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(ProvisioningRepository) private readonly repo: ProvisioningRepository,
    @Inject(InviteService) private readonly invites: InviteService,
    @Inject(RefreshService) private readonly refresh: RefreshService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * Render a refusal AND put it on the record.
   *
   * ADR 0043 §5 requires every call audited «including rejected ones»: a probing integration that
   * leaves no trace is indistinguishable from no integration at all. The detail carries the key's
   * fingerprint and the reason CLASS — never a value, never an email, never the body.
   */
  async refuse(
    accountId: string,
    key: ApiKeyFacts | null,
    refusal: ProvisioningRefusal,
    instance: string,
    hrEmployeeId?: string,
  ): Promise<ProvisioningOutcome> {
    const status = REFUSAL_STATUS[refusal];
    const type = REFUSAL_TYPE[refusal];
    if (key) {
      await this.audit.append(accountId || key.accountId, {
        actorUserId: '',
        actorKind: 'system',
        actorRef: `api-key:${key.fingerprint}`,
        action: 'provisioning.rejected',
        targetRef: hrEmployeeId ? hashEmployeeId(key.accountId, hrEmployeeId) : key.id,
        detail: {
          keyFingerprint: key.fingerprint,
          reasonClass: refusal,
          ...(hrEmployeeId ? { employeeIdHash: hashEmployeeId(key.accountId, hrEmployeeId) } : {}),
        },
      });
    }
    // ⚠️ A refusal that could not be attributed to a key (unknown id, malformed request) writes NO
    // audit row on purpose: there is no account to write it to, and inventing one would put an
    // unauthenticated stranger's traffic into a tenant's trail. The edge's own logs carry the count.
    return {
      statusCode: status,
      problemType: type,
      outcome: 'refused',
      bodyJson: problem(type, 'Request refused', status, 'The request was refused.', instance),
    };
  }

  /**
   * Create — one pending invitation carrying the newcomer role, or the re-hire branches (§7).
   *
   * The three outcomes are the operator's whole hiring reality: a new person, a returning person,
   * and a duplicate event about somebody already working here. None of them is an error at HR:
   * «do not error loudly at HR; do not create a twin» is the ADR's own instruction.
   */
  async create(
    key: ApiKeyFacts,
    body: { hrEmployeeId?: string; email?: string },
    instance: string,
  ): Promise<ProvisioningOutcome> {
    const hrEmployeeId = (body.hrEmployeeId ?? '').trim();
    const email = (body.email ?? '').trim().toLowerCase();
    if (!hrEmployeeId || !email || !email.includes('@')) {
      return this.refuse(key.accountId, key, 'malformed', instance, hrEmployeeId || undefined);
    }

    const existingByEmployee = await this.repo.userIdForEmployee(key.accountId, hrEmployeeId);
    const existingUser = existingByEmployee
      ? await this.repo.findUserById(key.accountId, existingByEmployee)
      : await this.repo.findUserByEmail(key.accountId, email);

    if (existingUser) {
      // ⚠️ The administrator bar, first direction: an HR event naming an administrator's account —
      // by id or by email — is refused before anything is written.
      const roles = await this.repo.roleKeysOf(existingUser.id);
      if (roles.some((r) => PRIVILEGED_ROLES.has(r))) {
        return this.refuse(key.accountId, key, 'forbidden_role', instance, hrEmployeeId);
      }
      // Bind the HR id even when we found the person by email: the next event about them must not
      // have to guess again (§7 — never two accounts for one human).
      await this.repo.bindEmployee(key.accountId, hrEmployeeId, existingUser.id);

      if (existingUser.status !== 'disabled') {
        await this.auditCreate(key, hrEmployeeId, 'noop_active');
        return this.ok(200, 'noop_active', instance, {
          outcome: 'noop_active',
          detail: 'This person already has an active account.',
        });
      }
      // Deactivated ⇒ a REACTIVATION invitation against the existing record. This is exactly what
      // §3 preserved the record for: the history, the authorship and the numbers come back with them.
      const invite = await this.invites.createProvisioningInvitation(
        key.accountId,
        existingUser.email,
        `api-key:${key.fingerprint}`,
      );
      if (invite.status !== 'created') {
        return this.refuse(key.accountId, key, 'forbidden_role', instance, hrEmployeeId);
      }
      await this.auditCreate(key, hrEmployeeId, 'reactivated');
      return this.ok(202, 'reactivated', instance, {
        outcome: 'reactivated',
        invitationSent: true,
      });
    }

    const invite = await this.invites.createProvisioningInvitation(
      key.accountId,
      email,
      `api-key:${key.fingerprint}`,
    );
    if (invite.status !== 'created') {
      // The only way this fails is a missing `newcomer` role — a stand that was never re-seeded.
      // Refusing beats inventing a role nobody granted anything to.
      return this.refuse(key.accountId, key, 'forbidden_role', instance, hrEmployeeId);
    }
    const created = await this.repo.findUserByEmail(key.accountId, email);
    if (created) await this.repo.bindEmployee(key.accountId, hrEmployeeId, created.id);
    await this.auditCreate(key, hrEmployeeId, 'invited');
    return this.ok(202, 'invited', instance, {
      outcome: 'invited',
      invitationSent: true,
    });
  }

  /**
   * Deactivate — close the account, end the sessions, keep the record (§3).
   *
   * ⚠️ **The handover is NOT done here, and it is not done in this REQUEST at all.** The work lives
   * in chats, this service holds no client to it, and the draft that had the gateway bridge the two
   * was wrong twice: it put an HTTP path onto a maintenance rpc (which makes that rpc's system-actor
   * gate decoration — `tests/worker/maintenance-ticks.spec.ts`), and it would have reported «the work
   * did not move» to the HR platform, leaving the fix to a retry by a system we neither control nor
   * test. The offboarding sweep in the worker owns it, so the guarantee rests on our own
   * infrastructure. What that costs is stated where a reader will need it: the work moves within a
   * tick, not within this response.
   */
  async deactivate(
    key: ApiKeyFacts,
    hrEmployeeId: string,
    instance: string,
  ): Promise<ProvisioningOutcome> {
    const userId = await this.repo.userIdForEmployee(key.accountId, hrEmployeeId);
    if (!userId) {
      // Unknown employee id: 404, and deliberately the same 404 whether they never existed or belong
      // to another account — a termination endpoint must not double as an existence oracle.
      return {
        statusCode: 404,
        problemType: 'not-found',
        outcome: 'refused',
        bodyJson: problem('not-found', 'Unknown employee', 404, 'No such staff member.', instance),
      };
    }
    const user = await this.repo.findUserById(key.accountId, userId);
    if (!user) {
      return {
        statusCode: 404,
        problemType: 'not-found',
        outcome: 'refused',
        bodyJson: problem('not-found', 'Unknown employee', 404, 'No such staff member.', instance),
      };
    }

    // ⚠️ The administrator bar, second direction (see the class header).
    const roles = await this.repo.roleKeysOf(user.id);
    if (roles.some((r) => PRIVILEGED_ROLES.has(r))) {
      return this.refuse(key.accountId, key, 'forbidden_role', instance, hrEmployeeId);
    }

    if (user.status === 'disabled') {
      // A repeated termination event is not an error (§3). It still asks for a handover: the first
      // call may have closed the account and failed to move the work, and this is the retry.
      await this.auditDeactivate(key, hrEmployeeId, 'noop_inactive');
      return this.ok(200, 'noop_inactive', instance, { outcome: 'noop_inactive' });
    }

    await this.repo.deactivateUser(key.accountId, user.id);
    await this.refresh.revokeUserChain(user.id);
    await this.auditDeactivate(key, hrEmployeeId, 'deactivated');
    return this.ok(200, 'deactivated', instance, { outcome: 'deactivated' });
  }

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────

  private ok(
    statusCode: number,
    outcome: string,
    instance: string,
    body: Record<string, unknown>,
  ): ProvisioningOutcome {
    return { statusCode, problemType: '', outcome, bodyJson: JSON.stringify({ ...body, instance }) };
  }

  private async auditCreate(key: ApiKeyFacts, hrEmployeeId: string, outcome: string): Promise<void> {
    await this.audit.append(key.accountId, {
      actorUserId: '',
      actorKind: 'system',
      actorRef: `api-key:${key.fingerprint}`,
      action: 'provisioning.create',
      targetRef: hashEmployeeId(key.accountId, hrEmployeeId),
      detail: {
        keyFingerprint: key.fingerprint,
        employeeIdHash: hashEmployeeId(key.accountId, hrEmployeeId),
        reasonClass: outcome,
      },
    });
  }

  private async auditDeactivate(key: ApiKeyFacts, hrEmployeeId: string, outcome: string): Promise<void> {
    await this.audit.append(key.accountId, {
      actorUserId: '',
      actorKind: 'system',
      actorRef: `api-key:${key.fingerprint}`,
      action: 'provisioning.deactivate',
      targetRef: hashEmployeeId(key.accountId, hrEmployeeId),
      detail: {
        keyFingerprint: key.fingerprint,
        employeeIdHash: hashEmployeeId(key.accountId, hrEmployeeId),
        reasonClass: outcome,
      },
    });
  }
}
