import { render, screen } from '@testing-library/react';
import { Providers } from '../../../app/providers';
import { Tags } from './tags';
import { getDataAccess, setDataAccess } from '@/data/provider';
import type { DataAccess } from '@/data/data-access';
import type { PaginatedResult, ResourceName } from '@/data/types';

/** W16 — the tag registry (subpoint 3.11). Busiest first, zero is a number, refusal is words. */

const WIRE = [
  { id: 't1', name: 'regular', color: '', usageCount: 4 },
  { id: 't2', name: 'auto_confirmation', color: '#0af', usageCount: 9 },
  { id: 't3', name: 'dead_tag', color: '', usageCount: 0 },
];

function stub(opts: { fails?: boolean } = {}): DataAccess {
  const page = <T,>(items: T[]): PaginatedResult<T> => ({ items, nextCursor: null, hasMore: false });
  return {
    async list<T = unknown>(resource: ResourceName): Promise<PaginatedResult<T>> {
      if (resource === 'label-usage') {
        if (opts.fails) throw { message: 'You do not have access to this.', retryable: false };
        return page(WIRE as unknown as T[]);
      }
      throw new Error(`unexpected list: ${resource}`);
    },
    async get<T = unknown>(): Promise<T> {
      throw new Error('not used');
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

function renderTags(s: DataAccess) {
  setDataAccess(s);
  return render(
    <Providers dataAccess={getDataAccess()}>
      <Tags />
    </Providers>,
  );
}

describe('the tag registry', () => {
  it('⭐ lists every tag with its count, BUSIEST FIRST — the question is "what do we actually use"', async () => {
    renderTags(stub());
    await screen.findByTestId('tags-list');
    const names = screen
      .getAllByTestId(/^tag-t\d$/)
      .map((li) => li.textContent ?? '');
    expect(names[0]).toContain('auto_confirmation');
    expect(names[0]).toContain('9');
    // A tag nobody uses shows a ZERO — a number, not a missing row: the dead tag is the finding.
    expect(screen.getByTestId('tag-count-t3')).toHaveTextContent('0');
  });

  it('a refusal is WORDS, never an empty table', async () => {
    renderTags(stub({ fails: true }));
    expect(await screen.findByTestId('tags-error')).toHaveTextContent('do not have access');
    expect(screen.queryByTestId('tags-list')).not.toBeInTheDocument();
  });
});
