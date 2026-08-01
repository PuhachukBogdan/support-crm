import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentService } from './assignment.service';
import { AssignmentController } from './assignment.grpc.controller';
import { AssignmentReadController } from './assignment.read.controller';
import { PlayerRepository } from '../player/player.repository';
import { OperatorRepository } from '../operator/operator.repository';

/**
 * Player ↔ AM attachment (feature 026, roadmap 5.7).
 *
 * ⚠️ A module nobody imports contributes no handlers, and the service then answers UNIMPLEMENTED
 * while looking perfectly healthy — feature 015's single Track-B failure. `hosting.spec.ts` asserts
 * this module is in the app graph rather than reasoning that it must be.
 *
 * `AssignmentRepository` is EXPORTED because the player read path needs it: the narrowing asks the
 * attachment a question on every masked read.
 */
@Module({
  controllers: [AssignmentController, AssignmentReadController],
  providers: [
    PrismaService,
    AssignmentRepository,
    AssignmentService,
    PlayerRepository,
    OperatorRepository,
  ],
  exports: [AssignmentRepository, AssignmentService],
})
export class AssignmentModule {}
