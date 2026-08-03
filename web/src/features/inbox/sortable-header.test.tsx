import { render, screen, fireEvent } from '@testing-library/react';
import { SortableHeader } from './sortable-header';
import { INBOX_COLUMNS } from './columns';
import { rowFor } from '@/data/gateway/registry';

/**
 * ⭐ The column-header triangles the operator asked for on 2026-08-03, from Zendesk's list:
 * *«где можно отсортировать от большего к меньшему — то треугольнички»*. One click sorts, the next
 * flips.
 *
 * ⛔ The load-bearing assertion is the **negative** one: a column the server cannot order by gets no
 * arrow. A sort control that reorders nothing is invisible when it fails — a wrongly ordered list is
 * still a list — which is why it is the one class of defect this screen keeps being audited for.
 */
const sortable = INBOX_COLUMNS.find((c) => c.sort)!;
const plain = INBOX_COLUMNS.find((c) => !c.sort)!;

describe('*** a header sorts only where the server can honour it ***', () => {
  it('⭐ every declared column sort maps to an order the ROUTE declares', () => {
    const declared = new Set(rowFor('conversations').orders ?? []);
    for (const col of INBOX_COLUMNS) {
      if (!col.sort) continue;
      expect(declared.has(col.sort.asc)).toBe(true);
      expect(declared.has(col.sort.desc)).toBe(true);
    }
  });

  it('⛔ a column with no server order renders NO control at all', () => {
    render(<SortableHeader column={plain} order="updated_desc" onOrderChange={() => {}} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(plain.header)).toBeInTheDocument();
  });

  it('⚠️ Status carries no arrow — a status is a set, not a scale (Zendesk does the same)', () => {
    const status = INBOX_COLUMNS.find((c) => c.id === 'status')!;
    expect(status.sort).toBeUndefined();
  });

  it('⚠️ Requested and Priority have no arrows YET — the server has no such orders', () => {
    // They get them in 9.2b step 2, with a real server order behind each. Until then an arrow there
    // would be a control that does nothing.
    expect(INBOX_COLUMNS.find((c) => c.id === 'createdAt')!.sort).toBeUndefined();
    expect(INBOX_COLUMNS.find((c) => c.id === 'priority')!.sort).toBeUndefined();
  });
});

describe('*** clicking flips the direction ***', () => {
  it('an unsorted column sorts DESCENDING first — newest first is what a queue means', () => {
    const onOrderChange = jest.fn();
    render(<SortableHeader column={sortable} order="something_else" onOrderChange={onOrderChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOrderChange).toHaveBeenCalledWith(sortable.sort!.desc);
  });

  it('a descending column flips to ascending, and back again', () => {
    const onOrderChange = jest.fn();
    const { rerender } = render(
      <SortableHeader column={sortable} order={sortable.sort!.desc} onOrderChange={onOrderChange} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOrderChange).toHaveBeenLastCalledWith(sortable.sort!.asc);

    rerender(
      <SortableHeader column={sortable} order={sortable.sort!.asc} onOrderChange={onOrderChange} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onOrderChange).toHaveBeenLastCalledWith(sortable.sort!.desc);
  });

  it('reports the direction to assistive tech — a triangle is not readable', () => {
    const { rerender } = render(
      <SortableHeader column={sortable} order={sortable.sort!.asc} onOrderChange={() => {}} />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-sort', 'ascending');

    rerender(
      <SortableHeader column={sortable} order={sortable.sort!.desc} onOrderChange={() => {}} />,
    );
    expect(screen.getByRole('button')).toHaveAttribute('aria-sort', 'descending');

    rerender(<SortableHeader column={sortable} order="none" onOrderChange={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-sort', 'none');
  });

  it('the accessible name says what the click will DO, not just the column name', () => {
    render(
      <SortableHeader column={sortable} order={sortable.sort!.desc} onOrderChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /sort by .*ascending/i })).toBeInTheDocument();
  });
});
