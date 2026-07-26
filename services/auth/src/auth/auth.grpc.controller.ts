import { Controller } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { LoginService } from './login.service';
import { TokenService } from './token.service';

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
    private readonly login: LoginService,
    private readonly tokens: TokenService,
  ) {}

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
}
