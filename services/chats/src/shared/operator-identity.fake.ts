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
