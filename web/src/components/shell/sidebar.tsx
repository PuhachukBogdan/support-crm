'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV_ITEMS } from './nav-items';

// Collapsible left navigation. Colors/spacing come only from tokens (white-label).
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'flex h-full flex-col border-r border-border bg-card transition-[width] duration-base ease-standard',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        {/* Neutral placeholder wordmark — no brand identity committed (0028). */}
        <div className="h-6 w-6 shrink-0 rounded bg-primary" aria-hidden />
        {!collapsed && <span className="truncate text-sm font-semibold">Support CRM</span>}
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto p-2">
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
