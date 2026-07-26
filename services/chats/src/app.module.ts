import { Module } from '@nestjs/common';
import { HealthGrpcController } from './health/health.controller';
import { PrismaService } from './prisma.service';
import { ChatsAccessGuard } from './security/permission.guard';
import { ConversationRepository } from './conversation/conversation.repository';
import { ConversationReadController } from './conversation/conversation.grpc.controller';
import { ConversationWriteController } from './conversation/conversation.write.controller';
import { MessageRepository } from './message/message.repository';
import { MessageReadController, MessageWriteController } from './message/message.grpc.controller';
import { FeedReadController } from './feed/feed.grpc.controller';
import { AssignmentRepository } from './assignment/assignment.repository';
import { AssignmentWriteController } from './assignment/assignment.grpc.controller';
import { LabelsRepository } from './labels/labels.repository';
import { LabelsController } from './labels/labels.grpc.controller';
import { MacrosRepository } from './macros/macros.repository';
import { MacrosController } from './macros/macros.grpc.controller';
import { CannedRepository } from './canned/canned.repository';
import { CannedController } from './canned/canned.grpc.controller';
import { RoundRobinStateRepository } from './assignment/round-robin-state.repository';
import { AutoAssignController } from './assignment/auto-assign.grpc.controller';

// Phase 1 (spec 003): health probe. Feature 012 (roadmap 4.1–4.3): the chats-core domain —
// ChatsReadService / ChatsWriteService over chats_db, account-scoped (forAccount) with a
// service-tier RBAC guard (ChatsAccessGuard). US1 conversations + US2 messages; feed lands in US3.
@Module({
  controllers: [
    HealthGrpcController,
    ConversationReadController,
    ConversationWriteController,
    MessageReadController,
    MessageWriteController,
    FeedReadController,
    // Feature 013 (roadmap 4.4/4.5): the workflow layer.
    AssignmentWriteController,
    AutoAssignController,
    LabelsController,
    MacrosController,
    CannedController,
  ],
  providers: [
    PrismaService,
    ConversationRepository,
    MessageRepository,
    ChatsAccessGuard,
    // Feature 013.
    AssignmentRepository,
    RoundRobinStateRepository,
    LabelsRepository,
    MacrosRepository,
    CannedRepository,
  ],
})
export class AppModule {}
