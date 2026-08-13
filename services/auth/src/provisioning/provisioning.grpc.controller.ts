import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ProvisioningRepository } from './provisioning.repository';
import { ProvisioningService } from './provisioning.service';
import { verifyProvisioningCall, type ApiKeyFacts } from './provisioning.verify';

/**
 * ⭐ W31 / feature 038 (roadmap 3.15, ADR 0043 §6): the machine path's one door into auth.
 *
 * ── No guard, and that is not an omission ───────────────────────────────────────────────────────
 * Every other rpc in this service is reached by a session the gateway validated. This one is reached
 * by a stranger's key, so the authentication IS the body of the method: `verifyProvisioningCall`
 * runs before anything else and its verdict decides everything. Putting a permission decorator here
 * would be theatre — there is no session to hold a permission.
 *
 * ── The shape of every answer ───────────────────────────────────────────────────────────────────
 * A rendered result (status, problem type, body) rather than an exception, because the gateway must
 * be able to return refusals verbatim without deciding anything, and because ADR 0043 §5's «every
 * call audited, including rejected» is only possible if a refusal is a value this code holds.
 */

const REPLAY_WINDOW_SECONDS = 300;

interface MachineCallWire {
  rawBody?: string;
  signatureHeader?: string;
  keyId?: string;
  keySecret?: string;
  idempotencyKey?: string;
  clientIp?: string;
  receivedAt?: number | string;
  hrEmployeeId?: string;
}

@Controller()
export class ProvisioningController {
  constructor(
    @Inject(ProvisioningService) private readonly provisioning: ProvisioningService,
    @Inject(ProvisioningRepository) private readonly repo: ProvisioningRepository,
    @Inject(ApiKeysService) private readonly keys: ApiKeysService,
  ) {}

  @GrpcMethod('AuthService', 'ProvisionStaff')
  async provisionStaff(req: MachineCallWire) {
    return this.run(req, 'create', '/api/provisioning/v1/staff');
  }

  @GrpcMethod('AuthService', 'DeactivateStaff')
  async deactivateStaff(req: MachineCallWire) {
    const hrEmployeeId = (req.hrEmployeeId ?? '').trim();
    return this.run(req, 'deactivate', `/api/provisioning/v1/staff/${hrEmployeeId}`);
  }

  /**
   * Verify → claim → act → settle. One shape for both operations, because the difference between
   * hiring and offboarding starts only after every credential question has been answered.
   */
  private async run(req: MachineCallWire, operation: 'create' | 'deactivate', instance: string) {
    const receivedAt =
      typeof req.receivedAt === 'string' ? Number.parseInt(req.receivedAt, 10) : (req.receivedAt ?? 0);

    // 1. The gate. Its refusals are values; each one is audited by the service below.
    const verdict = await verifyProvisioningCall(
      {
        keyId: (req.keyId ?? '').trim(),
        keySecret: (req.keySecret ?? '').trim(),
        signatureHeader: req.signatureHeader,
        rawBody: req.rawBody ?? '',
        clientIp: req.clientIp,
        idempotencyKey: req.idempotencyKey,
        receivedAt: Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Math.floor(Date.now() / 1000),
        replayWindowSeconds: REPLAY_WINDOW_SECONDS,
      },
      {
        findKey: (keyId) => this.keys.factsFor(keyId),
        verifySecret: (hash, secret) => this.keys.verifySecret(hash, secret),
        countRecentCalls: (keyId) =>
          this.repo.countRecentCalls(keyId, new Date(Date.now() - 3_600_000)),
      },
    );

    if (!verdict.ok) {
      const out = await this.provisioning.refuse(
        verdict.key?.accountId ?? '',
        verdict.key,
        verdict.refusal,
        instance,
        (req.hrEmployeeId ?? '').trim() || undefined,
      );
      return this.wire(out);
    }

    const key: ApiKeyFacts = verdict.key;

    // 2. Claim the idempotency key. A retry with the same body replays; with a different body it is
    //    a conflict — a reused key must never silently apply different content (§6).
    const claim = await this.repo.claim({
      accountId: key.accountId,
      apiKeyId: key.id,
      idempotencyKey: verdict.idempotencyKey,
      operation,
      bodyHash: verdict.bodyHash,
    });

    if (claim.kind === 'conflict') {
      return this.wire({
          statusCode: 409,
          problemType: 'idempotency-conflict',
          outcome: 'refused',
          bodyJson: JSON.stringify({
            type: 'https://crm.local/problems/idempotency-conflict',
            title: 'Idempotency key reused',
            status: 409,
            detail: 'This idempotency key was used for a different request.',
            instance,
          }),
        });
    }

    if (claim.kind === 'replay') {
      // ⚠️ The FIRST call's answer, verbatim — including its status. A retry that got a fresh answer
      // would make «the same result with no second side effect» half true: no side effect, but a
      // different story, which is how a caller ends up believing two different things happened.
      await this.keys.markUsed(key.id);
      return this.wire({
          statusCode: claim.statusCode,
          problemType: '',
          outcome: claim.outcome,
          bodyJson: claim.bodyJson,
        });
    }

    // 3. Do the work.
    let outcome;
    if (operation === 'create') {
      let body: { hrEmployeeId?: string; email?: string } = {};
      try {
        const parsed: unknown = JSON.parse(req.rawBody ?? '{}');
        // ⚠️ Parsed from the bytes that were VERIFIED, never from fields the edge decoded: if the
        // gateway sent both, the thing signed and the thing applied would be two objects and only
        // one of them was signed.
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as { hrEmployeeId?: string; email?: string };
        }
      } catch {
        body = {};
      }
      outcome = await this.provisioning.create(key, body, instance);
    } else {
      outcome = await this.provisioning.deactivate(key, (req.hrEmployeeId ?? '').trim(), instance);
    }

    // 4. Settle the ledger with what we answered, and stamp the key as used (accepted calls only —
    //    a refused call must not make a dead key look alive).
    await this.repo.settle(claim.id, outcome.statusCode, outcome.bodyJson, outcome.outcome);
    await this.keys.markUsed(key.id);
    return this.wire(outcome);
  }

  private wire(out: {
    statusCode: number;
    problemType: string;
    outcome: string;
    bodyJson: string;
  }) {
    return {
      statusCode: out.statusCode,
      problemType: out.problemType,
      outcome: out.outcome,
      bodyJson: out.bodyJson,
    };
  }
}
