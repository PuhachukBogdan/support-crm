import { render, screen } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Analytics } from './analytics';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';

/**
 * W20 — the analytics screen (11.1 minimum). Shape claims: the four tiles carry the numbers, an
 * unmeasured first reply reads as a DASH (never 0s), the agent axes resolve ids to names
 * (degrading to the id), the chart draws one bar per day, and a refusal is words.
 */

const SNAPSHOT = {
  createdToday: 3,
  openNow: 7,
  avgFirstReplySeconds: 95,
  firstReplyCount: 12,
  byChannel: [
    { key: 'email', count: 5 },
    { key: '', count: 2 },
  ],
  byAgent: [
    { key: 'op-1', count: 4 },
    { key: '', count: 3 },
  ],
  pendingByAgent: [{ key: 'op-1', count: 2 }],
  volumeByDay: [
    { key: '2026-08-05', count: 0 },
    { key: '2026-08-06', count: 2 },
    { key: '2026-08-07', count: 3 },
  ],
};

function stub(opts: { fails?: boolean; avg?: number } = {}): DataAccess {
  return {
    async list(): Promise<never> {
      throw new Error('not used');
    },
    async get<T = unknown>(resource: string, id: string): Promise<T> {
      if (resource === 'analytics-snapshot') {
        if (opts.fails) throw { message: 'You do not have access to this.', retryable: false };
        return { ...SNAPSHOT, avgFirstReplySeconds: opts.avg ?? SNAPSHOT.avgFirstReplySeconds } as T;
      }
      if (resource === 'operators') {
        if (id === 'op-1') return { operatorId: 'op-1', displayName: 'Ann A.' } as T;
        throw { message: 'Not found.', retryable: false };
      }
      throw new Error(`unexpected get: ${resource}`);
    },
    async create<T = unknown>(): Promise<T> {
      throw new Error('not used');
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

function renderAnalytics(s: DataAccess) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Analytics />
    </Providers>,
  );
}

describe('the live numbers (6.2 + 6.4)', () => {
  it('⭐ four tiles, the parking-lot total among them', async () => {
    renderAnalytics(stub());
    await screen.findByTestId('stat-tiles');
    expect(screen.getByTestId('stat-created-today')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-open-now')).toHaveTextContent('7');
    expect(screen.getByTestId('stat-first-reply')).toHaveTextContent('2 мин');
    expect(screen.getByTestId('stat-pending')).toHaveTextContent('2');
  });

  it('an unmeasured first reply is a DASH with the reason — never a zero pretending to be instant', async () => {
    renderAnalytics(stub({ avg: -1 }));
    const tile = await screen.findByTestId('stat-first-reply');
    expect(tile).toHaveTextContent('—');
    expect(tile).toHaveTextContent('ещё не измерялся');
  });

  it('agents resolve to NAMES where the read answers, and the unassigned is a labelled absence', async () => {
    renderAnalytics(stub());
    const agents = await screen.findByTestId('by-agent');
    // The name appears in BOTH agent lists (open and pending) — that is the point of the shared map.
    expect(await screen.findAllByText('Ann A.')).toHaveLength(2);
    expect(agents).toHaveTextContent('не назначено');
    expect(screen.getByTestId('pending-by-agent')).toHaveTextContent('Ann A.');
  });
});

describe('the one chart (6.3)', () => {
  it('draws one bar per day, hover carries the exact number', async () => {
    renderAnalytics(stub());
    await screen.findByTestId('volume-chart');
    expect(screen.getByTestId('bar-2026-08-06')).toHaveAttribute('title', '2026-08-06: 2');
    expect(screen.getByTestId('bar-2026-08-05')).toBeInTheDocument(); // a zero day is a bar, not a hole
  });
});

describe('the refusal', () => {
  it('is WORDS, never an empty dashboard', async () => {
    renderAnalytics(stub({ fails: true }));
    expect(await screen.findByTestId('analytics-error')).toHaveTextContent('do not have access');
    expect(screen.queryByTestId('stat-tiles')).not.toBeInTheDocument();
  });
});
