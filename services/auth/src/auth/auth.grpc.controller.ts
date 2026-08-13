import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { LoginService } from './login.service';
import { TokenService } from './token.service';
import { RefreshService } from './refresh.service';
import { OnboardingService } from './onboarding.service';
import { InviteService } from './invite.service';
import { RegistrationService } from './registration.service';
import { OutboundEmailService } from './mail/outbound-email.service';
// ⭐ W36 / 041 — password recovery and the signed-in change.
import type { Metadata } from '@grpc/grpc-js';
import { readActorContext } from '../security/actor-context';
import { RecoveryService, type CompleteRecoveryOutcome } from './recovery.service';
import { PasswordService } from './password.service';

/**
 * ⭐ W36 / 041 — outcome → wire, by NAME as well as by tag.
 *
 * ⚠️ proto-loader runs with `enums: String`, so the wire carries `"RECOVERY_OUTCOME_OK"` and not `1`.
 * Feature 025 lost a live iteration to exactly this and it is written down four times now
 * (`gotchas/grpc-wire-encoding-enums-longs`) — writes kept working while reads broke, and every unit
 * test stayed green.
 *
 * `revokedCount` is always present: «signed out everywhere» is a NUMBER, not a promise.
 */
const RECOVERY_WIRE = (
  outcome: CompleteRecoveryOutcome | { status: 'bad_token' } | { status: 'not_eligible' },
) => {
  const word: Record<string, string> = {
    ok: 'RECOVERY_OUTCOME_OK',
    bad_token: 'RECOVERY_OUTCOME_BAD_TOKEN',
    expired: 'RECOVERY_OUTCOME_EXPIRED',
    already_used: 'RECOVERY_OUTCOME_ALREADY_USED',
    weak_password: 'RECOVERY_OUTCOME_WEAK_PASSWORD',
    not_eligible: 'RECOVERY_OUTCOME_NOT_ELIGIBLE',
  };
  return {
    outcome: word[outcome.status] ?? 'RECOVERY_OUTCOME_UNSPECIFIED',
    revokedCount: 'revokedCount' in outcome ? outcome.revokedCount : 0,
    failures: 'failures' in outcome ? outcome.failures : [],
  };
};

// Request/response shapes as delivered by proto-loader (keepCase:false → camelCase;
// longs:String → int64 fields are strings on the wire; enums:String → enum NAMES on the wire).
interface LoginRequest {
  email: string;
  password: string;
}
interface VerifyLoginCodeRequest {
  challengeId: string;
  code: string;
  rememberMe: boolean;
}
interface ValidateTokenRequest {
  accessToken: string;
}
interface RefreshRequest {
  refreshToken: string;
}
interface LogoutRequest {
  refreshToken: string;
}
interface RequestActivationRequest {
  email: string;
}
interface CompleteActivationRequest {
  email: string;
  code: string;
  password: string;
}
interface CreateInvitationRequest {
  inviterUserId: string;
  inviterAccountId: string;
  inviterRoles: string[];
  email: string;
  roleKey: string;
}
interface StartRegistrationRequest {
  inviteToken: string;
  email: string;
}
interface CompleteRegistrationRequest {
  inviteToken: string;
  email: string;
  code: string;
  password: string;
}

/** proto InvitationStatus enum names (enums:String). */
const INVITATION_WIRE: Record<'created' | 'forbidden' | 'rate_limited', string> = {
  created: 'INVITATION_CREATED',
  forbidden: 'INVITATION_FORBIDDEN',
  rate_limited: 'INVITATION_RATE_LIMITED',
};

/** proto LoginStatus enum names (enums:String) — the wire values the gateway receives. */
const STATUS_WIRE: Record<'code_sent' | 'invalid_credentials' | 'locked', string> = {
  code_sent: 'CODE_SENT',
  invalid_credentials: 'INVALID_CREDENTIALS',
  locked: 'LOCKED',
};

/**
 * AuthService gRPC controller (feature 009, T018). Implements the two-step login surface:
 *  - `Login` → `LoginChallenge` (status + opaque challenge; NEVER a token here).
 *  - `VerifyLoginCode` → `TokenPair` (only after a valid code is consumed — SEC-2, no bypass).
 *  - `ValidateToken` → `TokenClaims` (local, DB-free verify; the authority path for the gateway).
 * Refresh / Logout / ResendLoginCode land in US2/US3.
 *
 * No password, code, or token is ever put in an error message or log (Principle IV).
 */
@Controller()
export class AuthGrpcController {
  constructor(
    @Inject(LoginService) private readonly login: LoginService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RefreshService) private readonly refresh: RefreshService,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
    @Inject(InviteService) private readonly invite: InviteService,
    @Inject(RegistrationService) private readonly registration: RegistrationService,
    @Inject(OutboundEmailService) private readonly outbox: OutboundEmailService,
    // ⭐ W36 / 041 — recovery and the signed-in change.
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  /**
   * ⭐ W36 / 041 — ask for a recovery link (roadmap 3.18).
   *
   * ⚠️ **One answer, always.** The service returns `void` precisely so this handler has nothing to
   * branch on: there is no value here that could differ for a known and an unknown address, which is
   * what makes «the form is not a staff directory» a property of the code rather than a discipline.
   */
  @GrpcMethod('AuthService', 'RequestPasswordRecovery')
  async requestPasswordRecoveryRpc(req: { email?: string; sourceRef?: string }) {
    await this.recovery.request(req?.email ?? '', req?.sourceRef ?? '');
    return {};
  }

  /**
   * ⭐ W36 / 041 — use the link. ⛔ Issues NO session (FR-009): the two-step login is not bypassed.
   */
  @GrpcMethod('AuthService', 'CompletePasswordRecovery')
  async completePasswordRecoveryRpc(req: { token?: string; password?: string }) {
    const outcome = await this.recovery.complete(req?.token ?? '', req?.password ?? '');
    return RECOVERY_WIRE(outcome);
  }

  /**
   * ⭐ W36 / 041 — change your own password.
   *
   * ⚠️ **The subject is the caller, taken from the validated metadata, and there is no field for anybody
   * else** (the `EnsureOwnOperator` construction). A wrong current password is refused and counts toward
   * the same lockout the login path uses — the grind against a change form is the same grind.
   */
  @GrpcMethod('AuthService', 'ChangeOwnPassword')
  async changeOwnPasswordRpc(req: { currentPassword?: string; newPassword?: string }, metadata: Metadata) {
    const actor = readActorContext(metadata);
    if (!actor.userId || !actor.accountId) return RECOVERY_WIRE({ status: 'not_eligible' });

    const current = req?.currentPassword ?? '';
    const next = req?.newPassword ?? '';
    if (!(await this.passwords.matchesCurrent(actor.userId, current))) {
      return RECOVERY_WIRE({ status: 'bad_token' });
    }
    // A change that changes nothing is a false receipt — and it would revoke every session for no
    // reason, which reads to the person as «something happened» when nothing did.
    if (current === next) return RECOVERY_WIRE({ status: 'bad_token' });

    const set = await this.passwords.setPassword({
      accountId: actor.accountId,
      userId: actor.userId,
      newPassword: next,
      action: 'password.changed',
      actor: { userId: actor.userId },
    });
    if (set.status === 'weak') return RECOVERY_WIRE({ status: 'weak_password', failures: set.failures });
    if (set.status === 'no_credential') return RECOVERY_WIRE({ status: 'not_eligible' });
    return RECOVERY_WIRE({ status: 'ok', revokedCount: set.revokedCount });
  }

  @GrpcMethod('AuthService', 'Login')
  async loginRpc(req: LoginRequest) {
    const outcome = await this.login.login(req.email, req.password);
    if (outcome.status === 'code_sent') {
      return {
        status: STATUS_WIRE.code_sent,
        challengeId: outcome.challengeId,
        codeExpiresAt: String(outcome.codeExpiresAt),
      };
    }
    // invalid_credentials / locked — no challenge, no token.
    return { status: STATUS_WIRE[outcome.status], challengeId: '', codeExpiresAt: '0' };
  }

  @GrpcMethod('AuthService', 'VerifyLoginCode')
  async verifyRpc(req: VerifyLoginCodeRequest) {
    const pair = await this.login.verifyLoginCode(req.challengeId, req.code, req.rememberMe);
    if (!pair) {
      // Generic — do not reveal whether the code was wrong, expired, consumed, or exhausted.
      throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message: 'invalid_code' });
    }
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: String(pair.accessExpiresAt),
      refreshExpiresAt: String(pair.refreshExpiresAt),
    };
  }

  @GrpcMethod('AuthService', 'ValidateToken')
  validateRpc(req: ValidateTokenRequest) {
    const claims = this.tokens.verifyAccessToken(req.accessToken);
    return {
      valid: claims.valid,
      userId: claims.userId,
      accountId: claims.accountId,
      roles: claims.roles,
      expiresAt: String(claims.expiresAt),
    };
  }

  @GrpcMethod('AuthService', 'Refresh')
  async refreshRpc(req: RefreshRequest) {
    const pair = await this.refresh.refresh(req.refreshToken);
    if (!pair) {
      throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message: 'invalid_refresh' });
    }
    return {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      accessExpiresAt: String(pair.accessExpiresAt),
      refreshExpiresAt: String(pair.refreshExpiresAt),
    };
  }

  @GrpcMethod('AuthService', 'Logout')
  async logoutRpc(req: LogoutRequest) {
    return { revoked: await this.refresh.logout(req.refreshToken) };
  }

  // --- Feature 010: super-admin whitelist onboarding (roadmap 3.8) ---

  @GrpcMethod('AuthService', 'RequestActivation')
  async requestActivationRpc(req: RequestActivationRequest) {
    // Uniform ack — reveals nothing about whitelist membership (anti-enumeration).
    await this.onboarding.requestActivation(req.email);
    return {};
  }

  @GrpcMethod('AuthService', 'CompleteActivation')
  async completeActivationRpc(req: CompleteActivationRequest) {
    const outcome = await this.onboarding.completeActivation(req.email, req.code, req.password);
    if (outcome.status === 'ok') {
      return {
        accessToken: outcome.pair.accessToken,
        refreshToken: outcome.pair.refreshToken,
        accessExpiresAt: String(outcome.pair.accessExpiresAt),
        refreshExpiresAt: String(outcome.pair.refreshExpiresAt),
      };
    }
    if (outcome.status === 'weak_password') {
      // INVALID_ARGUMENT → gateway maps to 422 (distinct from a generic auth failure).
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'weak_password' });
    }
    throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message: 'invalid' });
  }

  // --- Feature 010: admin-center invite (roadmap 3.9) ---

  @GrpcMethod('AuthService', 'CreateInvitation')
  async createInvitationRpc(req: CreateInvitationRequest) {
    const outcome = await this.invite.createInvitation(
      { userId: req.inviterUserId, accountId: req.inviterAccountId, roles: req.inviterRoles ?? [] },
      req.email,
      req.roleKey,
    );
    return {
      status: INVITATION_WIRE[outcome.status],
      invitationId: outcome.status === 'created' ? outcome.invitationId : '',
    };
  }

  // --- Feature 010: registration (roadmap 3.10) ---

  @GrpcMethod('AuthService', 'StartRegistration')
  async startRegistrationRpc(req: StartRegistrationRequest) {
    const outcome = await this.registration.startRegistration(req.inviteToken, req.email);
    if (outcome.status === 'code_sent') {
      return { status: 'REGISTRATION_CODE_SENT', codeExpiresAt: String(outcome.codeExpiresAt) };
    }
    return { status: 'REGISTRATION_INVALID', codeExpiresAt: '0' };
  }

  @GrpcMethod('AuthService', 'CompleteRegistration')
  async completeRegistrationRpc(req: CompleteRegistrationRequest) {
    const outcome = await this.registration.completeRegistration(
      req.inviteToken,
      req.email,
      req.code,
      req.password,
    );
    if (outcome.status === 'ok') {
      return {
        accessToken: outcome.pair.accessToken,
        refreshToken: outcome.pair.refreshToken,
        accessExpiresAt: String(outcome.pair.accessExpiresAt),
        refreshExpiresAt: String(outcome.pair.refreshExpiresAt),
      };
    }
    if (outcome.status === 'weak_password') {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'weak_password' });
    }
    throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message: 'invalid' });
  }

  /**
   * Feature 028 — the mail sweep's entry point. The worker's tick calls this on a clock; the
   * sending happens HERE, in the service that owns the codes.
   *
   * ⚠️ Counts in, counts out. Nothing about a message crosses this wire — putting a live one-time
   * code into a gRPC payload was the alternative design, and it would have spread the one secret
   * this system is most careful about into a second process (spec 028 research R2).
   */
  @GrpcMethod('AuthService', 'SendDueEmails')
  async sendDueEmailsRpc(req: { batch?: number }) {
    const batch = Math.min(Math.max(Number(req.batch) || 10, 1), 100);
    return this.outbox.sendDue(batch);
  }
}
