'use client';

import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InboxColumn } from './columns';

/**
 * A column header that can sort — the triangles from Zendesk's list
 * (`ui-design/screenshots/views_2.png`), asked for by the operator on 2026-08-03:
 * *«где можно отсортировать от большего к меньшему — то треугольнички»*.
 *
 * One click sorts one way, the next flips it, exactly as he described.
 *
 * ⛔ **Rendered only for a column the SERVER can order by.** A header arrow that reorders nothing is
 * worse than a missing one: a wrong order still looks like a list, so nobody can see the control
 * lied. Which columns qualify is `InboxColumn.sort`, and that is populated from the orders the route
 * declares — the same rule that keeps the sort dropdown honest.
 *
 * ⓘ Zendesk shows no arrow on **Ticket status** either; a status is a set, not a scale.
 */
export function SortableHeader({
  column,
  order,
  onOrderChange,
}: {
  column: InboxColumn;
  order: string;
  onOrderChange: (order: string) => void;
}) {
  if (!column.sort) return <span>{column.header}</span>;

  const isAsc = order === column.sort.asc;
  const isDesc = order === column.sort.desc;
  const active = isAsc || isDesc;
  // Ascending first, then flip. An inactive column starts descending: on a queue, "newest first" is
  // what a person means by sorting on a time column.
  const next = isDesc ? column.sort.asc : column.sort.desc;

  const Icon = isAsc ? ChevronUp : isDesc ? ChevronDown : ChevronsUpDown;

  return (
    <button
      type="button"
      data-testid={`sort-${column.id}`}
      // The accessible name says what the click will DO, not what the column is called — a screen
      // reader user cannot see which way the triangle points.
      aria-label={`Sort by ${column.header}, ${isDesc ? 'ascending' : 'descending'}`}
      aria-sort={isAsc ? 'ascending' : isDesc ? 'descending' : 'none'}
      onClick={() => onOrderChange(next)}
      className={cn(
        'inline-flex items-center gap-1 font-medium hover:text-foreground',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {column.header}
      <Icon className={cn('h-3.5 w-3.5 shrink-0', !active && 'opacity-50')} aria-hidden />
    </button>
  );
}
