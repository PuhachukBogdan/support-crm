import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { ConversationsController } from './conversations.controller';
import { MessagesController } from './messages.controller';
import { FeedController } from './feed.controller';

/**
 * Gateway chats edge (feature 012). Thin REST surface over the chats gRPC service (Principle VIII —
 * routing + JWT + policy only, no business logic). Conversation / message / feed controllers are
 * added as their user stories land (US1–US3). Imports {@link GrpcClientsModule} for the CHATS_CLIENT
 * proxy; RBAC is enforced by the global PermissionGuard (SecurityModule) via `@RequiresPermission`.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [ConversationsController, MessagesController, FeedController],
})
export class ChatsModule {}
