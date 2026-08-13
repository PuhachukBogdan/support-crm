import { render, screen, fireEvent } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { SessionProvider } from '@/session/session-provider';
import { GatewaySession } from '@/session/gateway-session';
import type { SessionState } from '@/session/session';
import type { HttpPort } from '@/data/gateway/http-port';
import { Vip } from './vip';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

/**
 * W17 — the VIP tab (4.4 + 4.5 + 4.6). Shape claims: the workspace exists only for the key's
 * holders (absence in words, not an empty shell), the portfolio renders as pairs, write-first
 * posts the four fields and answers with the ticket link, and the server's refusal stays beside
 * the form.
 */

const silentPort: HttpPort = async () => ({ status: 0, body: undefined });

interface Stub extends DataAccess {
  creates: Array<{ resource: ResourceName; payload: unknown }>;
}

function stub(opts: { initiateFails?: boolean } = {}): Stub {
  const creates: Stub['creates'] = [];
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    creates,
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'my-players') {
        return page([{ brandId: 'b1', playerId: 'player-7' }] as unknown as T[]);
      }
      if (resource === 'conversations') {
        return page([{ id: 'c1', subject: 'Bonus question', statusKey: 'open' }] as unknown as T[]);
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async create<T = unknown>(resource: ResourceName, input: unknown): Promise<T> {
      creates.push({ resource, payload: input });
      if (opts.initiateFails) throw { message: 'The request was not valid.', retryable: false };
      return { id: 'conv-new' } as T;
    },
    async update<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('not used');
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderVip(s: Stub, permissionKeys: string[]) {
  setDataAccess(s);
  const seed: SessionState = { kind: 'authenticated', userId: 'me', accountId: 'a1', roles: ['am'], permissionKeys };
  return render(
    <Providers dataAccess={getDataAccess()}>
      <SessionProvider impl={new GatewaySession(silentPort)} seed={seed}>
        <Vip />
      </SessionProvider>
    </Providers>,
  );
}

const AM_KEYS = ['crm.inbox.view', 'crm.conversation.reply', 'crm.vip.workspace'];

describe('4.5 — the module belongs to the key', () => {
  it('⛔ without `crm.vip.workspace` the page is WORDS, and no portfolio read even fires', async () => {
    renderVip(stub(), ['crm.inbox.view', 'crm.conversation.reply']);
    expect(await screen.findByTestId('vip-not-available')).toHaveTextContent('granted, never enabled');
    expect(screen.queryByTestId('portfolio-list')).not.toBeInTheDocument();
  });
});

describe('4.4 — the portfolio and their tickets', () => {
  it('renders the pair, the card link, and the tickets the server already narrowed', async () => {
    renderVip(stub(), AM_KEYS);
    await screen.findByTestId('portfolio-list');
    expect(screen.getByTestId('player-b1-player-7')).toHaveTextContent('player-7');
    expect(screen.getByTestId('vip-tickets')).toHaveTextContent('Bonus question');
  });
});

describe('4.6 — write first', () => {
  it('⭐ posts brand+player+subject+body to the initiate path and answers with the ticket link', async () => {
    const s = stub();
    renderVip(s, AM_KEYS);
    fireEvent.click(await screen.findByTestId('write-first-player-7'));
    fireEvent.change(screen.getByTestId('subject-player-7'), { target: { value: 'A word' } });
    fireEvent.change(screen.getByTestId('body-player-7'), { target: { value: 'Hello there.' } });
    fireEvent.click(screen.getByTestId('send-first-player-7'));

    await screen.findByTestId('initiated-player-7');
    expect(s.creates[0]).toMatchObject({
      resource: 'initiate-email',
      payload: { brandId: 'b1', playerId: 'player-7', subject: 'A word', body: 'Hello there.' },
    });
    expect(screen.getByTestId('initiated-player-7').querySelector('a')).toHaveAttribute(
      'href',
      '/tickets/conv-new',
    );
  });

  it('the server’s refusal (no address, not yours…) stays beside the form, which stays open', async () => {
    renderVip(stub({ initiateFails: true }), AM_KEYS);
    fireEvent.click(await screen.findByTestId('write-first-player-7'));
    fireEvent.change(screen.getByTestId('body-player-7'), { target: { value: 'Hello.' } });
    fireEvent.click(screen.getByTestId('send-first-player-7'));

    expect(await screen.findByTestId('initiate-error-player-7')).toHaveTextContent('not valid');
    expect(screen.getByTestId('body-player-7')).toBeInTheDocument();
  });
});
