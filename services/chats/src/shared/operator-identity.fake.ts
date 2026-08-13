import type { OperatorIdentityClient } from './operator-identity.client';
import type { ReadMarkRepository } from '../conversation/read-mark.repository';

/**
 * Test doubles for the rail's two collaborators (W5, roadmap 4.19) — the same one-file idiom as
 * `realtime.fake.ts`, and with the same discipline: the fakes model the CONTRACT (identity may be
 * absent; the mark write is fire-and-observe), never a happier version of it.
 */

/** The caller has no operator identity — how every pre-W5 test implicitly ran. */
export function noOperatorIdentity(): OperatorIdentityClient {
  return {
    resolveCallerOperatorId: async () => null,
  } as unknown as OperatorIdentityClient;
}

/** The caller IS this operator — for tests exercising the mark write. */
export function fakeOperatorIdentity(operatorId: string): OperatorIdentityClient {
  return {
    resolveCallerOperatorId: async () => operatorId,
  } as unknown as OperatorIdentityClient;
}

/** Records every mark write, so a spec asserts WHO was stamped — or that nobody was. */
export function recordingReadMarks(): {
  repo: ReadMarkRepository;
  reads: Array<{ accountId: string; conversationId: string; operatorId: string }>;
} {
  const reads: Array<{ accountId: string; conversationId: string; operatorId: string }> = [];
  const repo = {
    recordRead: async (accountId: string, conversationId: string, operatorId: string) => {
      reads.push({ accountId, conversationId, operatorId });
    },
  } as unknown as ReadMarkRepository;
  return { repo, reads };
}

/** The no-assertions double for tests that only need the constructor satisfied. */
export function noReadMarks(): ReadMarkRepository {
  return recordingReadMarks().repo;
}

/**
 * W9: the lookup proxy's two extra constructor deps, for specs that never look anybody up. The
 * prisma stub THROWS on touch — a spec that reaches it is a spec that should be using real doubles.
 */
export function noLookupDeps(): [never, never] {
  return [
    { forAccount: () => { throw new Error('lookup not used in this spec'); } } as never,
    { record: () => { throw new Error('lookup not used in this spec'); } } as never,
  ];
}

/**
 * ⭐ W25: the unread-badge repository, for specs that never read the badge. Zeros, honestly —
 * the same contract shape the rpc reports for a caller with no operator identity.
 */
export function noInboxUnseen(): import('../conversation/inbox-unseen.repository').InboxUnseenRepository {
  return {
    markOpened: async () => new Date(0),
    unseen: async () => ({ count: 0, openedAt: null }),
  } as unknown as import('../conversation/inbox-unseen.repository').InboxUnseenRepository;
}
