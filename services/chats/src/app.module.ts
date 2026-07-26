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
  ],
  providers: [PrismaService, ConversationRepository, MessageRepository, ChatsAccessGuard],
})
export class AppModule {}
