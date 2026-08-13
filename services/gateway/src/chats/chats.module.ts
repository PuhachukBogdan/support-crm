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
import { PersonController } from './person.controller';
// ⭐ Feature 033 (roadmap 6.1): the channel intake edge. It lives in `../channels/` rather than here
// because it is not an operator-facing chats route — it is the one @Public() route in the product whose
// caller holds no session, and grouping it with the session-guarded chats surface would invite somebody
// to add a sibling that inherits the exemption by accident.
import { ChannelsController } from '../channels/channels.controller';
// ⭐ W15 (roadmap 6.8 minimum): the channels ADMIN edge — session-guarded, at `/admin/channels`,
// deliberately a different prefix from the public intake route above (two authentication stories
// must not share one).
import { ChannelsAdminController } from '../channels/channels-admin.controller';
// ⭐ W15a (subpoint 3.14): the status authoring writes — the read stays on /conversations/statuses.
import { StatusesAdminController } from './statuses-admin.controller';
// ⭐ Feature 037 (roadmap 4.15 — W30): the fields/forms edge — authoring at /admin/field-config,
// the per-conversation view and the two ticket writes at /conversations/:id/….
import { FieldConfigController } from './field-config.controller';
// ⭐ W20 (roadmap 11.1 minimum): the analytics snapshot — aggregates only.
import { AnalyticsController } from './analytics.controller';

/**
 * Gateway chats edge (feature 012). Thin REST surface over the chats gRPC service (Principle VIII —
 * routing + JWT + policy only, no business logic). Conversation / message / feed controllers are
 * added as their user stories land (US1–US3). Imports {@link GrpcClientsModule} for the CHATS_CLIENT
 * proxy; RBAC is enforced by the global PermissionGuard (SecurityModule) via `@RequiresPermission`.
 */
@Module({
  imports: [GrpcClientsModule],
  controllers: [
    ChannelsController,
    ChannelsAdminController,
    StatusesAdminController,
    FieldConfigController,
    AnalyticsController,
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
    // Feature 022 (roadmap 4.13): the person level — `GetPersonFeed` finally has a route, and the
    // person contact summary with it. A controller nobody registers serves nothing while looking healthy.
    PersonController,
  ],
})
export class ChatsModule {}
