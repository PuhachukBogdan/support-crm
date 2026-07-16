'use client';

import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/composites/data-table';
import { StatusBadge } from '@/components/composites/status-badge/status-badge';
import { useRecords } from '@/store/async/hooks';
import type { DemoRecord } from '@/data/mock/demo-data';

// Dashboard (D2): a mock ticket list assembled from the kit — DataTable fed by useRecords
// (the C data-access interface), StatusBadge columns. Mock data now; real gateway later
// behind the same interface.
const columns: ColumnDef<DemoRecord, unknown>[] = [
  { id: 'subject', accessorKey: 'subject', header: 'Subject' },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => <StatusBadge kind="status" value={row.original.status} />,
  },
  {
    id: 'priority',
    header: 'Priority',
    cell: ({ row }) => <StatusBadge kind="priority" value={row.original.priority} />,
  },
  { id: 'updatedAt', accessorKey: 'updatedAt', header: 'Updated' },
];

export default function DashboardHome() {
  const state = useRecords({ limit: 25 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Tickets</h1>
      <DataTable columns={columns} state={state} getRowId={(r) => r.id} onRetry={state.refetch} />
    </div>
  );
}
