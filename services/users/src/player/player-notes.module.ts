import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PlayerRepository } from './player.repository';
import { OperatorRepository } from '../operator/operator.repository';
import { AssignmentModule } from '../assignment/assignment.module';
import { PlayerNoteRepository } from './player-note.repository';
import { PlayerNoteService } from './player-note.service';
import { PlayerNotesController } from './player-note.grpc.controller';

/**
 * Player notes (W35 / feature 040 — R35 · U17).
 *
 * ⚠️ **A module nobody imports contributes no handlers**, and the service then answers UNIMPLEMENTED
 * while looking perfectly healthy — feature 015's single Track-B failure, and W31 met the same class
 * again when `auth` would not boot at all under a green suite (every spec builds its subject directly,
 * so nothing exercised the module graph). `hosting.spec.ts` asserts this module is in the graph rather
 * than reasoning that it must be.
 *
 * `AssignmentModule` is IMPORTED for its exported `AssignmentRepository`: the notes clearance is the
 * attachment question, and it must be the SAME attachment read the masked player read uses. A local
 * copy of that query would be a second mechanism deciding access (ADR 0039 §2) — the divergence this
 * repo's guards exist to catch.
 */
@Module({
  imports: [AssignmentModule],
  controllers: [PlayerNotesController],
  providers: [
    PrismaService,
    PlayerNoteRepository,
    PlayerNoteService,
    PlayerRepository,
    OperatorRepository,
  ],
  exports: [PlayerNoteService],
})
export class PlayerNotesModule {}
