import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.js';
import { Skeleton } from './states.js';

export interface Column<Row> {
  id: string;
  header: string;
  cell: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  /** Hide the column below this breakpoint; keep essential info in always-visible columns. */
  showFrom?: 'sm' | 'md' | 'lg' | 'xl';
  /** Visually hide the header text (still announced). */
  hideHeader?: boolean;
  className?: string;
}

const showFrom = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

interface DataTableProps<Row> {
  /** Accessible table name, announced to screen readers. */
  caption: string;
  columns: Column<Row>[];
  rows: Row[];
  getRowKey: (row: Row) => string;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  className?: string;
}

export function DataTable<Row>({
  caption,
  columns,
  rows,
  getRowKey,
  loading = false,
  skeletonRows = 5,
  empty,
  className,
}: DataTableProps<Row>): React.JSX.Element {
  const cellBase = (column: Column<Row>): string =>
    cn(
      'px-3 sm:px-4 align-middle',
      column.align === 'right' ? 'text-right' : 'text-left',
      column.showFrom && showFrom[column.showFrom],
      column.className,
    );

  const showEmpty = !loading && rows.length === 0 && empty;

  return (
    <div
      role="region"
      aria-label={`${caption} (scrollable)`}
      tabIndex={0}
      className={cn('overflow-x-auto', className)}
    >
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-y border-border bg-surface-muted/70">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={cn(
                  cellBase(column),
                  'h-9 text-xs font-medium tracking-wide whitespace-nowrap text-fg-subtle',
                )}
              >
                <span className={column.hideHeader ? 'sr-only' : undefined}>{column.header}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {loading
            ? Array.from({ length: skeletonRows }, (_, index) => (
                <tr key={index} aria-hidden="true">
                  {columns.map((column) => (
                    <td key={column.id} className={cn(cellBase(column), 'h-14')}>
                      <Skeleton className="h-4 w-3/4 max-w-40" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr key={getRowKey(row)} className="transition-colors hover:bg-surface-muted/50">
                  {columns.map((column) => (
                    <td key={column.id} className={cn(cellBase(column), 'h-14 py-2')}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {showEmpty ? <div className="border-t border-border">{empty}</div> : null}
    </div>
  );
}
