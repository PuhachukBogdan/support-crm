import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { GrpcClientsModule } from '../grpc/clients.module';
import { GATEWAY_CONFIG, loadGatewayConfig } from '../config';

/**
 * Gateway session-edge module (feature 009). Provides the validated gateway config, the REST
 * auth endpoints (`/auth/*`), and registers the AuthGuard **globally** (APP_GUARD) so every
 * route is protected unless marked `@Public()`. The guard verifies the access JWT locally
 * (Principle VII); the controller dials the AuthService over gRPC (AUTH_CLIENT).
 */
@Module({
  imports: [GrpcClientsModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    { provide: GATEWAY_CONFIG, useFactory: () => loadGatewayConfig() },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthEdgeModule {}
