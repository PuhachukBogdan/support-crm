import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Channels } from './channels';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

/**
 * W15 — the channels admin screen (roadmap 6.8 minimum, subpoint 3.10). Shape claims: what the
 * screen shows (the KEY above all — the thing the operator asked to see), where the one write
 * goes, and that a refusal is words beside the control rather than a blanked table.
 */

const CHANNELS = [
  { id: 'ch-api', brandId: 'b1', kind: 'api', key: 'stand-api-brand1', address: '', enabled: true },
  { id: 'ch-em', brandId: 'b1', kind: 'email', key: 'stand-email-brand1', address: 'support@stand.test', enabled: true },
  { id: 'ch-off', brandId: 'b2', kind: 'api', key: 'retired-key', address: '', enabled: false },
];
const BRANDS = [
  { brandId: 'b1', name: 'Brand One' },
  { brandId: 'b2', name: 'Brand Two' },
];

interface Stub extends DataAccess {
  writes: Array<{ resource: ResourceName; id: string; payload: unknown }>;
}

function stub(opts: { listFails?: boolean; writeFails?: boolean } = {}): Stub {
  const writes: Stub['writes'] = [];
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    writes,
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'admin-channels') {
        if (opts.listFails) throw { message: 'You do not have access to this.', retryable: false };
        return page(CHANNELS as unknown as T[]);
      }
      if (resource === 'brands') return page(BRANDS as unknown as T[]);
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used');
    },
    async update<T = unknown>(resource: ResourceName, id: string, patch: unknown): Promise<T> {
      writes.push({ resource, id, payload: patch });
      if (opts.writeFails) throw { message: 'The request was not valid.', retryable: false };
      return {} as T;
    },
    async remove<T = void>(): Promise<T> {
      throw new Error('not used');
    },
    subscribe() {
      return () => undefined;
    },
  };
}

function renderChannels(s: Stub) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Channels />
    </Providers>,
  );
}

describe('the channels table', () => {
  it('⭐ shows each channel with its brand NAME, kind, and the KEY the operator asked to see', async () => {
    renderChannels(stub());
    await screen.findByTestId('channels-list');
    expect(screen.getByTestId('channel-ch-api')).toHaveTextContent('Brand One');
    expect(screen.getByTestId('channel-key-ch-api')).toHaveTextContent('stand-api-brand1');
    expect(screen.getByTestId('channel-address-ch-em')).toHaveTextContent('support@stand.test');
  });

  it('a disabled channel says so in words — the stop button’s state, visible at last', async () => {
    renderChannels(stub());
    await screen.findByTestId('channels-list');
    expect(screen.getByTestId('channel-disabled-ch-off')).toHaveTextContent('not taking work in');
    expect(screen.queryByTestId('channel-disabled-ch-api')).not.toBeInTheDocument();
  });

  it('⭐ a refusal is WORDS, never an empty table (the W11 rule)', async () => {
    renderChannels(stub({ listFails: true }));
    expect(await screen.findByTestId('channels-error')).toHaveTextContent('do not have access');
    expect(screen.queryByTestId('channels-list')).not.toBeInTheDocument();
  });
});

describe('changing an email channel’s address', () => {
  it('goes to the email-channel placement keyed by BRAND, and the row is the receipt', async () => {
    const s = stub();
    renderChannels(s);
    fireEvent.click(await screen.findByTestId('change-address-ch-em'));
    fireEvent.change(screen.getByTestId('address-input-ch-em'), { target: { value: 'new@stand.test' } });
    fireEvent.click(screen.getByTestId('address-save-ch-em'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      resource: 'admin-email-channel',
      id: 'b1',
      payload: { address: 'new@stand.test' },
    });
  });

  it('a refusal stays beside the form, which stays open', async () => {
    renderChannels(stub({ writeFails: true }));
    fireEvent.click(await screen.findByTestId('change-address-ch-em'));
    fireEvent.change(screen.getByTestId('address-input-ch-em'), { target: { value: 'new@stand.test' } });
    fireEvent.click(screen.getByTestId('address-save-ch-em'));

    expect(await screen.findByTestId('address-error-ch-em')).toHaveTextContent('not valid');
    expect(screen.getByTestId('address-input-ch-em')).toBeInTheDocument();
  });
});

describe('adding a brand’s first mail address', () => {
  it('offers ONLY brands with no email channel, and places the address by brand id', async () => {
    const s = stub();
    renderChannels(s);
    await screen.findByTestId('add-email-form');

    fireEvent.keyDown(screen.getByTestId('add-email-brand'), { key: 'Enter' });
    // b1 already has an email channel — the menu must offer only Brand Two. Scoped to menu items:
    // the names also appear in the table rows above, which is not what this asserts.
    expect(await screen.findByRole('menuitem', { name: 'Brand Two' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Brand One' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'Brand Two' }));
    fireEvent.change(screen.getByTestId('add-email-address'), { target: { value: 'support@two.test' } });
    fireEvent.click(screen.getByTestId('add-email-save'));

    await waitFor(() => expect(s.writes).toHaveLength(1));
    expect(s.writes[0]).toMatchObject({
      resource: 'admin-email-channel',
      id: 'b2',
      payload: { address: 'support@two.test' },
    });
    expect(await screen.findByTestId('add-email-done')).toBeInTheDocument();
  });
});
