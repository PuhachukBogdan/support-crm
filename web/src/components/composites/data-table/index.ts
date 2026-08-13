export { DataTable, type DataTableProps } from './data-table';
// Tiering is S2's (density-spec §7): the rule and its vocabulary live here, screens declare a tier.
export { columnsThatFit, tierOf, ROW_HEIGHT, ROW_HEIGHT_CLASS, type ColumnTier } from './data-table';
export type { ColumnDef } from '@tanstack/react-table';
