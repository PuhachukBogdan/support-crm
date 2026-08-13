import { render, waitFor } from '@testing-library/react';
import { useLiveRefresh } from './use-live-refresh';
import { stubConversations } from './test-support';
import { DataAccessProvider } from '@/data/provider';
import type { Query } from '@/data/types';

/**
 * T032/T035 (feature 034, W4 — FR-012/FR-013) — **an event makes the list ask again, and nothing else.**
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ What this can prove and what it cannot. It proves the REACTION: one event in, one re-read out, through
 * the injected port. It cannot prove a row appears on a screen — jsdom has no layout and no server — which
 * is why the block also carries `live-w4.sh` and a person watching an unattended browser.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const QUERY: Query = { limit: 50 };

/** A probe component: it does nothing but subscribe, so a failure here is never a rendering artefact. */
function Probe({ query, refetch }: { query: Query; refetch: () => void }) {
  useLiveRefresh(query, refetch);
  return null;
}

const EVENT = {
  kind: 'conversation.created',
  accountId: 'acc-1',
  conversationId: 'conv-1',
} as const;

describe('the list re-reads when the server says something changed', () => {
  it('one event ⇒ exactly ONE re-read', async () => {
    const stub = stubConversations();
    let reads = 0;
    render(
      <DataAccessProvider impl={stub}>
        <Probe query={QUERY} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );

    stub.emit(EVENT);
    await waitFor(() => expect(reads).toBe(1));
  });

  it('two events ⇒ two re-reads (nothing is coalesced or dropped)', async () => {
    const stub = stubConversations();
    let reads = 0;
    render(
      <DataAccessProvider impl={stub}>
        <Probe query={QUERY} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );

    stub.emit(EVENT);
    stub.emit({ ...EVENT, kind: 'message.created', messageId: 'msg-1' });
    await waitFor(() => expect(reads).toBe(2));
  });

  /**
   * ⓘ `message.created` counts, deliberately: the Inbox shows last activity and orders by it, so a new
   * message changes the row. Filtering it out here would be a rule the list's own columns contradict.
   */
  it('a reconnection is a reason to re-read too', async () => {
    const stub = stubConversations();
    let reads = 0;
    render(
      <DataAccessProvider impl={stub}>
        <Probe query={QUERY} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );

    stub.emit({ kind: 'reconnected' });
    await waitFor(() => expect(reads).toBe(1));
  });

  /**
   * ⭐ The limitation, asserted rather than described. `refetch` re-reads with `cursor: null`, and this list
   * pages by APPENDING — so refreshing under somebody who has paged deeper would replace an accumulated
   * list with page one, and the screen would jump to the top while they were reading it.
   *
   * Being briefly stale below page one is the better failure. If this test is ever "fixed" to refresh
   * anyway, that is the behaviour being chosen.
   */
  it('holds off while the reader has paged deeper', async () => {
    const stub = stubConversations();
    let reads = 0;
    render(
      <DataAccessProvider impl={stub}>
        <Probe query={{ ...QUERY, cursor: 'conv-0050' }} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );

    stub.emit(EVENT);
    // Positive control: prove the harness CAN deliver, or this assertion passes for the wrong reason.
    await waitFor(() => expect(reads).toBe(0));
    const firstPage = render(
      <DataAccessProvider impl={stub}>
        <Probe query={QUERY} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );
    stub.emit(EVENT);
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    firstPage.unmount();
  });

  it('unmounting unsubscribes — a closed screen does not keep re-reading', async () => {
    const stub = stubConversations();
    let reads = 0;
    const view = render(
      <DataAccessProvider impl={stub}>
        <Probe query={QUERY} refetch={() => (reads += 1)} />
      </DataAccessProvider>,
    );

    view.unmount();
    stub.emit(EVENT);
    await waitFor(() => expect(reads).toBe(0));
  });
});
