import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  OnModuleInit,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Request, Response } from 'express';
import { firstValueFrom, type Observable } from 'rxjs';
import { AUTH_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from './auth.guard';

interface InvitationResultWire {
  status: string; // INVITATION_CREATED | INVITATION_FORBIDDEN | INVITATION_RATE_LIMITED
  invitationId: string;
}
interface InviteGrpc {
  createInvitation(data: {
    inviterUserId: string;
    inviterAccountId: string;
    inviterRoles: string[];
    email: string;
    roleKey: string;
  }): Observable<InvitationResultWire>;
}

interface InviteBody {
  email: string;
  role: string;
}

/**
 * Gateway edge for admin-center invites (feature 010, roadmap 3.9). GUARDED (no `@Public`): the
 * global AuthGuard requires a valid session, and the caller's identity/roles are taken from the
 * VALIDATED access-token claims (`req.claims`) — never from the request body (Principle II). Thin:
 * forwards to `AuthService.CreateInvitation` and maps the status to 201/403/429.
 */
@Controller('auth')
export class InviteController implements OnModuleInit {
  private auth!: InviteGrpc;

  constructor(@Inject(AUTH_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.auth = this.client.getService<InviteGrpc>('AuthService');
  }

  @Post('invites')
  @HttpCode(HttpStatus.CREATED)
  async invite(
    @Body() body: InviteBody,
    @Req() req: Request & { claims?: RequestClaims },
    @Res({ passthrough: true }) res: Response,
  ) {
    const claims = req.claims;
    if (!claims) {
      // Defense-in-depth: the global guard should have set this; fail closed if not.
      res.status(HttpStatus.UNAUTHORIZED);
      return { status: 'unauthorized' };
    }
    const result = await firstValueFrom(
      this.auth.createInvitation({
        inviterUserId: claims.userId,
        inviterAccountId: claims.accountId,
        inviterRoles: claims.roles ?? [],
        email: body.email,
        roleKey: body.role,
      }),
    );
    if (result.status === 'INVITATION_CREATED') {
      return { status: 'created', invitationId: result.invitationId };
    }
    if (result.status === 'INVITATION_RATE_LIMITED') {
      res.status(HttpStatus.TOO_MANY_REQUESTS);
      return { status: 'rate_limited' };
    }
    res.status(HttpStatus.FORBIDDEN);
    return { status: 'forbidden' };
  }
}
