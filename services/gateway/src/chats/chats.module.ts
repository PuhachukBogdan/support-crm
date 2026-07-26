import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/clients.module';
import { ConversationsController } from './conversations.controller';
import { MessagesController } from './messages.controller';
import { FeedController } from './feed.controller';
import { AssignmentController } from './assignment.controller';
import { LabelsController } from './labels.controller';
import { MacrosController } from './macros.controller';
import { CannedController } from './canned.controller';
import { AutomationsController } from './automations.controller';
import { SlaController } from './sla.controller';

/**
 * Gateway chats edge (feature 012). Thin REST surface over the chats gRPC service (Principle VIII —
 * routing + JWT + policy only, no business logic). Conversation / message / feed controllers are
 * added as their user stories land (US1–US3). Imports {@link GrpcClientsModule} for the CHATS_CLIENT
 * proxy; RBAC is enforced by the global PermissionGuard (SecurityModule) via `@RequiresPermission`.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [
    ConversationsController,
    MessagesController,
    FeedController,
    // Feature 013 (roadmap 4.4/4.5).
    AssignmentController,
    LabelsController,
    MacrosController,
    CannedController,
    // Feature 014 (roadmap 4.6/4.7).
    AutomationsController,
    SlaController,
  ],
})
export class ChatsModule {}
