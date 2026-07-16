import { render, screen, fireEvent } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from './data-table';
import { makeDemoRecords, type DemoRecord } from '@/data/mock/demo-data';
import type { AsyncState, PaginatedResult } from '@/data/types';

// T020 [US3] — DataTable: virtualization at scale, keyset loadMore, sort emit, row select, states.

// jsdom computes no layout; give the virtualizer's scroll viewport a real size so it produces
// a bounded window of rows (in the browser this comes from ResizeObserver / real layout).
const realGBCR = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {} } as DOMRect;
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realGBCR;
});

const columns: ColumnDef<DemoRecord, unknown>[] = [
  { id: 'subject', accessorKey: 'subject', header: 'Subject' },
  { id: 'status', accessorKey: 'status', header: 'Status' },
];

const ready = (
  items: DemoRecord[],
  hasMore = false,
): AsyncState<PaginatedResult<DemoRecord>> => ({
  status: 'ready',
  data: { items, nextCursor: hasMore ? 'cursor' : null, hasMore },
});

describe('DataTable', () => {
  it('virtualizes: bounded rendered rows regardless of dataset size (SC-003)', () => {
    const items = makeDemoRecords(100_000);
    render(<DataTable columns={columns} state={ready(items)} getRowId={(r) => r.id} />);

    const rendered = document.querySelectorAll('tr[data-index]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200); // bounded — NOT 100k
    expect(items).toHaveLength(100_000);
  });

  it('paginates by keyset: Load more calls onLoadMore when hasMore (SC-004)', () => {
    const onLoadMore = jest.fn();
    render(
      <DataTable
        columns={columns}
        state={ready(makeDemoRecords(10), true)}
        getRowId={(r) => r.id}
        onLoadMore={onLoadMore}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('emits a sort change when a sortable header is clicked', () => {
    const onSortChange = jest.fn();
    render(
      <DataTable
        columns={columns}
        state={ready(makeDemoRecords(10))}
        getRowId={(r) => r.id}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Subject' }));
    expect(onSortChange).toHaveBeenCalledWith([{ field: 'subject', dir: 'desc' }]);
  });

  it('tracks row selection', () => {
    const onChange = jest.fn();
    render(
      <DataTable
        columns={columns}
        state={ready(makeDemoRecords(20))}
        getRowId={(r) => r.id}
        rowSelection={{ selected: [], onChange }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Select row 00000001'));
    expect(onChange).toHaveBeenCalledWith(['00000001']);
  });

  it('renders shared loading / empty / error states', () => {
    const { rerender } = render(
      <DataTable columns={columns} state={{ status: 'loading' }} getRowId={(r) => r.id} />,
    );
    expect(screen.getByTestId('dt-loading')).toBeInTheDocument();

    rerender(<DataTable columns={columns} state={{ status: 'empty' }} getRowId={(r) => r.id} />);
    expect(screen.getByTestId('dt-empty')).toBeInTheDocument();

    const onRetry = jest.fn();
    rerender(
      <DataTable
        columns={columns}
        state={{ status: 'error', error: { message: 'Failed', retryable: true } }}
        getRowId={(r) => r.id}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByTestId('dt-error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });
});
