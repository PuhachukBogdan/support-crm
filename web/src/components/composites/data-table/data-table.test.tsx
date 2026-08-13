import { render, screen, fireEvent } from '@testing-library/react';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable, ROW_HEIGHT, ROW_HEIGHT_CLASS, columnsThatFit, tierOf } from './data-table';
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

  /**
   * The scroll-smoothness regression (reported 2026-08-04: *«скролл поддёргивает и дрожит и стоит на
   * месте»*).
   *
   * ⚠️ **jsdom computes no layout, so nothing here can prove the scroll is smooth** — the two facts
   * below are the invariants the smoothness rests on, and they are the only part that is checkable off
   * a real browser. A headed run is what confirms the symptom is gone (see quickstart, Track B).
   */
  describe('scroll geometry', () => {
    it('pins every virtualized row to the height the virtualizer budgets for it', () => {
      render(
        <DataTable columns={columns} state={ready(makeDemoRecords(500))} getRowId={(r) => r.id} />,
      );
      const rendered = Array.from(document.querySelectorAll('tr[data-index]'));
      expect(rendered.length).toBeGreaterThan(0);
      // An unpinned row is laid out by its content (~37 px), and the difference accumulates per row.
      for (const row of rendered) {
        expect(row.className.split(/\s+/)).toContain(ROW_HEIGHT_CLASS);
      }
    });

    it('keeps the pinned class and the estimate the same number', () => {
      // Tailwind's height scale is 0.25rem per step at a 16 px root: `h-11` → 11 × 4 = 44 px.
      const step = Number(ROW_HEIGHT_CLASS.replace(/^h-/, ''));
      expect(Number.isFinite(step)).toBe(true);
      expect(step * 4).toBe(ROW_HEIGHT);
    });

    /**
     * Reported 2026-08-04, after the pin: *«если на полный экран открывать то не дергается но если на
     * пол экрана то еще немножко дергается»*. A squeezed cell wrapped to a second line, so the row
     * outgrew the pin — the drift returning through width instead of content.
     */
    it('keeps cells to one clipped line, so row height cannot depend on width', () => {
      render(
        <DataTable columns={columns} state={ready(makeDemoRecords(200))} getRowId={(r) => r.id} />,
      );
      const cells = Array.from(document.querySelectorAll('tr[data-index] > td'));
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell.className.split(/\s+/)).toContain('truncate');
      }
      // Auto layout would answer a forbidden wrap by widening the table instead — `columns.ts` rules
      // out sideways scrolling, so the declared widths have to be the authority.
      expect(document.querySelector('table')?.className).toContain('table-fixed');
    });

    it('leaves the checkbox column unclipped', () => {
      render(
        <DataTable
          columns={columns}
          state={ready(makeDemoRecords(20))}
          getRowId={(r) => r.id}
          rowSelection={{ selected: [], onChange: () => {} }}
        />,
      );
      // `overflow-hidden` on this one clips the focus ring, and there is nothing to truncate.
      const first = document.querySelector('tr[data-index] > td');
      expect(first?.className ?? '').not.toContain('truncate');
    });

    it('opts the scroll viewport out of browser scroll anchoring', () => {
      render(
        <DataTable columns={columns} state={ready(makeDemoRecords(500))} getRowId={(r) => r.id} />,
      );
      // Virtualization unmounts the node anchoring would try to hold still, so the browser must not
      // correct scrollTop underneath it.
      expect(screen.getByTestId('dt-scroll').className).toContain('[overflow-anchor:none]');
    });
  });

  /**
   * Tiering (`ui-design/density-spec.md` §2, obligation S2 in §7). The mechanism moved here from
   * `features/inbox/columns.ts`, which had invented numeric priorities and measured `window.innerWidth`.
   *
   * ⚠️ The pure-rule tests are not enough on their own — the previous layer's rule tests all passed
   * while the decision sat in the wrong place and read the wrong width. So the last test drives the
   * rendered table: *test the consumer, not only the rule.*
   */
  describe('column tiers', () => {
    const tiered: ColumnDef<DemoRecord, unknown>[] = [
      { id: 'subject', accessorKey: 'subject', header: 'Subject', size: 400, meta: { tier: 'essential' } },
      { id: 'status', accessorKey: 'status', header: 'Status', size: 300, meta: { tier: 'essential' } },
      { id: 'assignee', accessorKey: 'assignee', header: 'Assignee', size: 300, meta: { tier: 'contextual' } },
      { id: 'category', accessorKey: 'category', header: 'Category', size: 200, meta: { tier: 'optional' } },
    ];

    it('sheds optional first, then contextual, and never an essential column', () => {
      expect(columnsThatFit(tiered, 5000).map((c) => c.id)).toEqual(['subject', 'status', 'assignee']);
      expect(columnsThatFit(tiered, 800).map((c) => c.id)).toEqual(['subject', 'status']);
      // At an absurd width the essentials remain and truncate instead — a list without its subject is
      // not a list, and truncation is now structural (`table-fixed` + clipped cells).
      expect(columnsThatFit(tiered, 1).map((c) => c.id)).toEqual(['subject', 'status']);
    });

    it('an unmeasured width keeps the default set rather than shedding everything', () => {
      expect(columnsThatFit(tiered, 0).map((c) => c.id)).toEqual(['subject', 'status', 'assignee']);
    });

    it('treats a column with no declared tier as essential, so existing callers are unaffected', () => {
      expect(tierOf({ id: 'x' } as ColumnDef<DemoRecord, unknown>)).toBe('essential');
      const untiered: ColumnDef<DemoRecord, unknown>[] = [
        { id: 'a', header: 'A', size: 900 },
        { id: 'b', header: 'B', size: 900 },
      ];
      expect(columnsThatFit(untiered, 100).map((c) => c.id)).toEqual(['a', 'b']);
    });

    it('⭐ the RENDERED table sheds by its own measured width, not by the window', () => {
      // The stub in this file reports 800px for every element, so the contextual column cannot fit
      // beside two 400+300 essentials — and `window.innerWidth` (1024 in jsdom) would have kept it.
      expect(window.innerWidth).toBeGreaterThan(800);
      render(<DataTable columns={tiered} state={ready(makeDemoRecords(30))} getRowId={(r) => r.id} />);

      const headers = Array.from(document.querySelectorAll('th')).map((th) => th.textContent);
      expect(headers).toContain('Subject');
      expect(headers).toContain('Status');
      expect(headers).not.toContain('Assignee');
      expect(headers).not.toContain('Category');
    });

    it('renders an optional column once opted into', () => {
      render(
        <DataTable
          columns={[tiered[0]!, tiered[3]!]}
          state={ready(makeDemoRecords(30))}
          getRowId={(r) => r.id}
          optionalColumns={['category']}
        />,
      );
      expect(Array.from(document.querySelectorAll('th')).map((th) => th.textContent)).toContain(
        'Category',
      );
    });
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
