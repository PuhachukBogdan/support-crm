import type { RealtimeEvent } from '@crm/common';
import type { RealtimePublisher } from './realtime.publisher';

/**
 * The test double for {@link RealtimePublisher} (feature 034, W4).
 *
 * ⚠️ **It RECORDS rather than swallows**, and that is deliberate. The cheap double here is
 * `{ publish: async () => true }`, which lets every spec compile and asserts nothing — so the eight
 * publish sites would be untested and a deleted call would stay green. This one hands back the list, so a
 * spec can say *"posting a message published exactly one `message.created` for this conversation"*.
 *
 * ⓘ The session that shipped W3 learned the sharper form of this: a double that is more permissive than
 * the thing it stands for turns a hard failure into a passing test
 * (`gotchas/a-fake-more-permissive-than-the-library`). A publisher has no protocol to violate, so the risk
 * here is the milder one — a double that makes assertions *impossible* rather than wrong — and the answer
 * is the same: model what the real one does, which is *deliver an event somewhere observable*.
 */
export function fakeRealtime(): { publisher: RealtimePublisher; published: RealtimeEvent[] } {
  const published: RealtimeEvent[] = [];
  const publish = async (event: RealtimeEvent): Promise<boolean> => {
    published.push(event);
    return true;
  };
  const publisher = {
    publish,
    conversation: (kind: 'conversation.created' | 'conversation.updated', accountId: string, conversationId: string) =>
      publish({ kind, accountId, conversationId }),
    message: (accountId: string, conversationId: string, messageId: string) =>
      publish({ kind: 'message.created', accountId, conversationId, messageId }),
    onModuleDestroy: () => undefined,
  } as unknown as RealtimePublisher;
  return { publisher, published };
}

/**
 * ⓘ There is deliberately **no throwing double here.** The tempting one — a publisher whose calls reject,
 * to prove each call site survives — would encode a requirement this design does not want: eight
 * `try/catch` blocks around eight publishes, protecting against a failure the publisher already swallows
 * by contract (FR-005).
 *
 * The property belongs where it lives: `realtime.publisher.spec.ts` asserts that a failing Redis client
 * makes `publish` return `false` rather than throw. One test at the boundary beats eight at the call sites,
 * and it fails if somebody ever removes the swallow.
 */
