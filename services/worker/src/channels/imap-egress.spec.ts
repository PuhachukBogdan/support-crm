import { ImapFlow } from 'imapflow';
import { ImapReaderService } from './imap-reader.service';

/**
 * T080 + the batch half of T038 (feature 033, US2) — **the guard runs before the socket, and one bad
 * message does not stop the intake** (FR-048/FR-034, SC-010).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THE HARM IS THE CONNECTION, so a test that checks the refusal AFTER connecting proves nothing.**
 * This counts `ImapFlow` CONSTRUCTIONS. A guard placed one line too late would still report a refusal,
 * still log the same message, and still have opened a socket to a host the allow-list forbids — which is
 * the entire thing Principle III exists to prevent. The pair of this test is `outbound.guards.spec.ts`
 * in US4, which proves the same property for the SMTP relay.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
jest.mock('imapflow', () => ({
  ImapFlow: jest.fn().mockImplementation(() => ({
    connect: async () => undefined,
    mailboxOpen: async () => undefined,
    on: () => undefined,
    logout: async () => undefined,
    usable: true,
    fetch: () => (async function* () {})(),
    messageFlagsAdd: async () => true,
  })),
}));

const ImapFlowMock = ImapFlow as unknown as jest.Mock;

const ENV = {
  NODE_ENV: 'test',
  GRPC_URL: '0.0.0.0:50055',
  REDIS_URL: 'redis://redis:6379',
  CHATS_GRPC_TARGET: 'chats:50053',
  USERS_GRPC_TARGET: 'users:50052',
  AUTH_GRPC_TARGET: 'auth:50051',
  CHANNEL_KEY: 'mail-key',
  CHANNEL_IMAP_HOST: 'greenmail',
  CHANNEL_IMAP_PORT: '3143',
  CHANNEL_IMAP_USER: 'support@stand.test',
  CHANNEL_IMAP_PASSWORD: 'stand',
};

function build(env: Record<string, string>) {
  const previous = { ...process.env };
  Object.assign(process.env, ENV, env);
  const redis = {
    client: {
      set: async () => 'OK',
      del: async () => 1,
    },
  } as unknown as import('../queue/redis.service').RedisService;
  const chats = {
    resolveIntakeChannel: async () => ({ accountId: 'acc-1', brandId: 'brand-1', kind: 'email' }),
    acceptInboundEmail: async () => ({ conversationId: 'conv-1', duplicate: false, refusalClass: '' }),
  } as unknown as import('../chats/chats.client').ChatsMaintenanceClient;
  const uploads = {
    storeInbound: async () => 'up-1',
  } as unknown as import('../users/users.client').UsersUploadsClient;

  const reader = new ImapReaderService(redis, chats, uploads);
  return {
    reader,
    restore: () => {
      process.env = previous;
    },
  };
}

beforeEach(() => ImapFlowMock.mockClear());

describe('the egress allow-list is checked before any socket is opened', () => {
  it('a host outside MAIL_ALLOWED_HOSTS is refused with NO connection attempted', async () => {
    const { reader, restore } = build({ MAIL_ALLOWED_HOSTS: 'mailpit,smtp.internal' });
    try {
      await reader.onModuleInit();
      // Give the un-awaited run loop a turn — `onModuleInit` deliberately does not block startup on a
      // slow mailbox, so the assertion has to let the microtask queue drain.
      await new Promise((r) => setTimeout(r, 10));
      expect(ImapFlowMock).not.toHaveBeenCalled();
    } finally {
      await reader.onModuleDestroy();
      restore();
    }
  });

  it('a host ON the list connects — the guard must not be a blanket refusal', async () => {
    // The other half of the property, and not a formality: a guard that refuses everything also passes
    // the test above, and would stop all mail while looking like security.
    const { reader, restore } = build({ MAIL_ALLOWED_HOSTS: 'greenmail:3143' });
    try {
      await reader.onModuleInit();
      await new Promise((r) => setTimeout(r, 10));
      expect(ImapFlowMock).toHaveBeenCalledTimes(1);
    } finally {
      await reader.onModuleDestroy();
      restore();
    }
  });

  it('no mailbox configured ⇒ no connection, and that is not an error', async () => {
    // Correct for every deployment with no email channel, including the whole test suite. An absent
    // mailbox is a legitimate configuration, unlike an unreachable chats service.
    const { reader, restore } = build({ CHANNEL_IMAP_HOST: '', MAIL_ALLOWED_HOSTS: '' });
    try {
      await reader.onModuleInit();
      await new Promise((r) => setTimeout(r, 10));
      expect(ImapFlowMock).not.toHaveBeenCalled();
    } finally {
      await reader.onModuleDestroy();
      restore();
    }
  });
});

describe('one poisonous message does not stop the batch (FR-034)', () => {
  /**
   * A fake mailbox serving three messages, the middle one unparseable.
   *
   * ⭐⭐ **IT REFUSES A COMMAND WHILE `fetch` IS STREAMING, BECAUSE THE REAL LIBRARY DOES** — added
   * 2026-08-05, after the W3 live round found that email intake had never worked once.
   *
   * `ImapFlow.fetch()` holds the connection until its async iterator is exhausted; a second command inside
   * the loop destroys the socket (`NoConnection`). The reader marked messages seen inside that loop, so the
   * first message of the first batch killed the connection, nothing was ever marked seen, and `run`
   * reconnected to fetch the same message and die again — for ever.
   *
   * ⚠️ **This fake used to permit it**, and that is the whole reason 4 194 tests were green while the
   * feature was completely inert: a plain async generator does not care what you do between yields, so the
   * double was more permissive than the thing it stood for. *A fake that accepts what the real dependency
   * rejects converts a hard failure into a passing test* — the same lesson `gotchas/grpc-wire-encoding-
   * enums-longs` records for a decoder, one layer down.
   */
  function mailbox(sources: Array<{ uid: number; source: Buffer }>) {
    const seen: number[] = [];
    let streaming = false;
    const refuseWhileStreaming = (what: string) => {
      if (streaming) {
        // The library's own failure, reproduced by name so a reader recognises it in a real log.
        throw Object.assign(new Error(`${what} while a fetch stream is open`), {
          code: 'NoConnection',
        });
      }
    };
    return {
      client: {
        usable: true,
        // One command, one array of uids — the reader asks for these before it fetches anything.
        search: async () => {
          refuseWhileStreaming('search');
          return sources.map((m) => m.uid);
        },
        fetch: () =>
          (async function* () {
            streaming = true;
            try {
              for (const m of sources) yield m;
            } finally {
              streaming = false;
            }
          })(),
        messageFlagsAdd: async (q: { uid: string }) => {
          refuseWhileStreaming('messageFlagsAdd');
          seen.push(Number(q.uid));
          return true;
        },
      } as unknown as ImapFlow,
      seen,
    };
  }

  const good = (id: string) =>
    Buffer.from(
      `From: p@mail.test\r\nMessage-ID: <${id}@mail.test>\r\nSubject: hi\r\n\r\nтекст\r\n`,
      'utf8',
    );

  it('takes in the messages either side of an unreadable one', async () => {
    // Feature 031 shipped the opposite shape — one bad row killed the whole tick — and it was found on a
    // live run rather than by a test. This is the loop-with-a-try-INSIDE that prevents it.
    const { reader, restore } = build({ MAIL_ALLOWED_HOSTS: '' });
    const { client, seen } = mailbox([
      { uid: 1, source: good('a') },
      { uid: 2, source: Buffer.from([0xff, 0xfe, 0x00]) },
      { uid: 3, source: good('c') },
    ]);
    try {
      // The tenant is normally resolved when the connection opens. Set directly so this test exercises
      // the batch loop alone rather than the connection lifecycle the tests above already cover.
      (reader as unknown as { tenant: unknown }).tenant = { accountId: 'acc-1', brandId: 'brand-1' };
      const counts = await reader.takeInUnseen(client);
      expect(counts).toEqual({ taken: 2, refused: 1 });
      // ⚠️ All three marked seen, including the refused one: a message we will never accept must not be
      // re-read for ever. An auto-reply loop would otherwise be refused once per reconnect, at machine
      // speed, for the lifetime of the mailbox.
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      restore();
    }
  });

  it('a message chats REFUSES retryably is left UNREAD so the next pass can take it', async () => {
    // The opposite decision from a parse refusal, and the difference matters: `identity_unavailable` means
    // a dependency was down, not that the message is unacceptable. Marking it seen would lose it.
    const previous = { ...process.env };
    Object.assign(process.env, ENV, { MAIL_ALLOWED_HOSTS: '' });
    const redis = { client: { set: async () => 'OK', del: async () => 1 } } as never;
    const chats = {
      resolveIntakeChannel: async () => ({ accountId: 'acc-1', brandId: 'brand-1', kind: 'email' }),
      acceptInboundEmail: async () => ({
        conversationId: '',
        duplicate: false,
        refusalClass: 'identity_unavailable',
      }),
    } as never;
    const uploads = { storeInbound: async () => 'up-1' } as never;
    const reader = new ImapReaderService(redis, chats, uploads);
    (reader as unknown as { tenant: unknown }).tenant = { accountId: 'acc-1', brandId: 'brand-1' };

    const { client, seen } = mailbox([{ uid: 9, source: good('r') }]);
    try {
      expect(await reader.takeInUnseen(client)).toEqual({ taken: 0, refused: 1 });
      expect(seen).toEqual([]);
    } finally {
      process.env = previous;
    }
  });
});
