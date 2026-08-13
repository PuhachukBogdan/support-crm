import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { OnboardingController } from './onboarding.controller';
import { InviteController } from './invite.controller';
import { RegistrationController } from './registration.controller';
import { AuthGuard } from './auth.guard';
import { GrpcClientsModule } from '../grpc/clients.module';
import { GATEWAY_CONFIG, loadGatewayConfig } from '../config';
// MVP block W1 (roadmap 5.10): a person who obtained a session must HAVE an operator profile, or they
// are unassignable. Composed here because `auth` and `users` have no clients for each other.
import { EnsureOperatorProfile } from './ensure-operator-profile';

/**
 * Gateway session-edge module (feature 009). Provides the validated gateway config, the REST
 * auth endpoints (`/auth/*`), and registers the AuthGuard **globally** (APP_GUARD) so every
 * route is protected unless marked `@Public()`. The guard verifies the access JWT locally
 * (Principle VII); the controller dials the AuthService over gRPC (AUTH_CLIENT).
 */
@Module({
  imports: [GrpcClientsModule, JwtModule.register({})],
  controllers: [AuthController, OnboardingController, InviteController, RegistrationController],
  providers: [
    { provide: GATEWAY_CONFIG, useFactory: () => loadGatewayConfig() },
    { provide: APP_GUARD, useClass: AuthGuard },
    EnsureOperatorProfile,
  ],
})
export class AuthEdgeModule {}
