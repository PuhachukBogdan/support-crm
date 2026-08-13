import { realtimeChannel } from '@crm/common';
import { RealtimePublisher } from './realtime.publisher';

/**
 * The publisher's three properties (feature 034, W4 — FR-003/FR-005).
 *
 * ⚠️ The Redis client is replaced by reaching into the private field rather than by mocking `ioredis`
 * module-wide: the point of these tests is what this class does with a client, and a module mock would
 * also erase the lazy construction, which is the first property below.
 */
/**
 * ⚠️ The double carries `on`, because the real client does and the publisher attaches an error handler.
 * A double missing it is how the listener-per-publish leak below was found: the first draft called `.on`
 * on every `connection()` and this test crashed on the second call rather than passing quietly.
 */
type Publishable = {
  publish: (channel: string, payload: string) => Promise<number>;
  on?: (event: string, handler: () => void) => void;
};

function withClient(url: string, client?: Publishable): RealtimePublisher {
  const previous = process.env.REDIS_URL;
  process.env.REDIS_URL = url;
  const publisher = new RealtimePublisher();
  process.env.REDIS_URL = previous;
  if (client) (publisher as unknown as { client: Publishable }).client = client;
  return publisher;
}

describe('the publisher is INERT without a Redis url (FR-003)', () => {
  /**
   * ⭐ A deployment with no realtime edge is legitimate — and so is the entire unit-test suite, which is
   * why this is the `CHANNEL_IMAP_HOST` reading (an absent thing is a configuration) and not the
   * `GRPC_URL` one (refuse to start). Nothing crash-loops because a socket was not configured.
   */
  it('publishes nothing and does not throw', async () => {
    const publisher = withClient('');
    await expect(publisher.publish({ kind: 'conversation.created', accountId: 'a', conversationId: 'c' })).resolves.toBe(false);
  });

  it('opens no connection at all — the client is never built', () => {
    const publisher = withClient('');
    expect((publisher as unknown as { client?: unknown }).client).toBeUndefined();
  });
});

describe('what reaches Redis (FR-001)', () => {
  it('publishes to the ACCOUNT channel, with the payload unchanged', async () => {
    const sent: Array<[string, string]> = [];
    const publisher = withClient('redis://redis:6379', {
      publish: async (channel, payload) => {
        sent.push([channel, payload]);
        return 1;
      },
    });

    await publisher.message('acc-1', 'conv-1', 'msg-1');

    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(realtimeChannel('acc-1'));
    expect(JSON.parse(sent[0]![1])).toEqual({
      kind: 'message.created',
      accountId: 'acc-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
    });
  });

  /**
   * The negative half, and the one that matters: nothing about the conversation is looked up and added.
   * The moment this class reads a row to "helpfully" include a subject, the socket becomes a read path and
   * inherits every rule the REST projection enforces — which is the whole thing this design avoids.
   */
  it('a conversation event carries three fields and no messageId', async () => {
    const sent: string[] = [];
    const publisher = withClient('redis://redis:6379', {
      publish: async (_c, payload) => {
        sent.push(payload);
        return 1;
      },
    });

    await publisher.conversation('conversation.created', 'acc-1', 'conv-1');

    expect(Object.keys(JSON.parse(sent[0]!)).sort()).toEqual(['accountId', 'conversationId', 'kind']);
  });
});

describe('a publish is BEST-EFFORT (FR-005)', () => {
  /**
   * ⭐⭐ The property the whole design rests on: **a notification may be lost; a fact may not.** A
   * customer's message must not fail to be recorded because Redis blinked.
   *
   * Asserted here, at the boundary, rather than by wrapping each of the eight call sites in a `try/catch`
   * — one test that fails if somebody removes the swallow beats eight that restate it.
   */
  it('a failing client makes publish return false instead of throwing', async () => {
    const publisher = withClient('redis://redis:6379', {
      publish: async () => {
        throw new Error('READONLY You cannot write against a read only replica');
      },
    });
    await expect(publisher.message('acc-1', 'conv-1', 'msg-1')).resolves.toBe(false);
  });

  it('logs the error CLASS and never the event or its ids', async () => {
    const lines: string[] = [];
    const spy = jest
      // Spied on the PROTOTYPE, not on an instance field the framework builds where a test cannot reach it.
      .spyOn(
        (await import('@nestjs/common')).Logger.prototype,
        'warn',
      )
      .mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
    try {
      const publisher = withClient('redis://redis:6379', {
        publish: async () => {
          throw new TypeError('connect ECONNREFUSED 172.19.0.9:6379');
        },
      });
      await publisher.message('acc-1-secret-tenant', 'conv-1', 'msg-1');
      // The positive control FIRST: a scan that asserts an absence passes just as well when nothing at all
      // was logged, which is the vacuous shape this project has hit seven times.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('TypeError');
      expect(lines[0]).not.toContain('acc-1-secret-tenant');
      expect(lines[0]).not.toContain('conv-1');
      expect(lines[0]).not.toContain('ECONNREFUSED 172.19.0.9');
    } finally {
      spy.mockRestore();
    }
  });
});
