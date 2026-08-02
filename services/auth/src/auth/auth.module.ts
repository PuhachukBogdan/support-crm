import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from '../prisma.service';
import { AUTH_CONFIG, loadAuthConfig } from '../config';
import { EMAIL_PORT } from './ports/email.port';
import { MAIL_TRANSPORT } from './mail/mail-transport';
import { SmtpMailTransport } from './mail/smtp.transport';
import { OutboundEmailService } from './mail/outbound-email.service';
import { QueueingEmailAdapter } from './mail/queueing-email.adapter';
import {
  ADMIN_NOTIFICATION_PORT,
  InMemoryAdminNotificationAdapter,
} from './ports/admin-notify.port';
import { CLOCK, SystemClock } from './ports/clock';
import { TokenService } from './token.service';
import { OtpService } from './otp.service';
import { LoginService } from './login.service';
import { RefreshService } from './refresh.service';
import { LockoutService } from './lockout.service';
import { OnboardingService } from './onboarding.service';
import { InviteService } from './invite.service';
import { RegistrationService } from './registration.service';
import { RateLimiter } from './rate-limiter';
import { AuthGrpcController } from './auth.grpc.controller';

/**
 * Auth domain module (feature 009). Wires the config, the Prisma client, the injectable clock,
 * the outbound seams (EmailPort, AdminNotificationPort), the domain services (token/otp/login),
 * and the gRPC controller (Login / VerifyLoginCode / ValidateToken; Refresh / Logout in US3).
 *
 * Bindings note: the EmailPort/AdminNotificationPort default to the in-memory dev adapters
 * (real SMTP/websocket transport is a later, isolated phase — Principle III). AUTH_CONFIG is
 * loaded via `loadAuthConfig()`, so the module (Track B / bootstrap) refuses to start without
 * `JWT_SECRET` (SEC-6). Unit specs construct the services directly with fakes, not this module.
 */
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET,
    }),
  ],
  controllers: [AuthGrpcController],
  providers: [
    PrismaService,
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    // ⭐ Feature 028 — the port now DELIVERS. `OutboxEmailAdapter` (in-memory) survives for unit
    // tests only, and `mail-structure.spec.ts` asserts that nothing outside a test references it:
    // an adapter that authenticates nobody but delivers nowhere is one binding away from being
    // live, which is the same argument feature 027 used for the mock session.
    { provide: MAIL_TRANSPORT, useClass: SmtpMailTransport },
    OutboundEmailService,
    { provide: EMAIL_PORT, useClass: QueueingEmailAdapter },
    { provide: ADMIN_NOTIFICATION_PORT, useClass: InMemoryAdminNotificationAdapter },
    { provide: CLOCK, useClass: SystemClock },
    TokenService,
    OtpService,
    LoginService,
    RefreshService,
    LockoutService,
    OnboardingService,
    InviteService,
    RegistrationService,
    RateLimiter,
  ],
  exports: [PrismaService, AUTH_CONFIG, EMAIL_PORT, ADMIN_NOTIFICATION_PORT, CLOCK, JwtModule],
})
export class AuthModule {}
