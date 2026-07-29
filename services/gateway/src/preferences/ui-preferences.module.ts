import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { UiPreferencesEdgeController } from './ui-preferences.controller';

/**
 * Gateway edge for the operator's UI preferences (feature 021, roadmap 5.6).
 *
 * Thin by construction, like the players, uploads and exports edges beside it: the only judgement in
 * this folder is transport-shape parsing. What a preference key is, what values it accepts and what
 * the defaults are all live in the closed catalogue the owning service enforces (Principle II).
 *
 * Reuses the existing users client rather than registering a second one.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [UiPreferencesEdgeController],
})
export class UiPreferencesEdgeModule {}
