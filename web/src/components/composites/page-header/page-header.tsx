import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Page title + actions + optional breadcrumbs. */
export function PageHeader({
  title,
  actions,
  breadcrumbs,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex items-center justify-between gap-4 border-b border-border pb-4', className)}
    >
      <div className="space-y-1">
        {breadcrumbs && <div className="text-xs text-muted-foreground">{breadcrumbs}</div>}
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Horizontal action group. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-center gap-2', className)}>{children}</div>;
}

/** Wrapping row of filter controls (a FilterBar owner debounces changes upstream). */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}
