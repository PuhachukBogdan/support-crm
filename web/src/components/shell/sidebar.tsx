'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { MODULE_CATALOGUE, parseModuleOverrides, resolveModules } from './nav-items';
import { PRODUCT_WORDMARK } from './branding';
import { useSession } from '@/session';

/**
 * Collapsible left navigation. Colors/spacing come only from tokens (white-label).
 *
 * ── Feature 029 (roadmap 9.1's missing criteria) ─────────────────────────────────────────────────
 * The rail is now **assembled from the caller's server-resolved permissions** (FR-020) and each entry
 * carries one of three module states (FR-021). ⛔ It is rendering only: a module absent here must
 * also have no route and no API answer, which is server-side and completed by 9.14.
 */
export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const { state } = useSession();
  // Deny-by-default: anything other than a resolved, authenticated session has no permissions, so the
  // rail shows only what needs none. An unresolved session must never render an admin's rail.
  const permissionKeys = state.kind === 'authenticated' ? state.permissionKeys : [];
  const modules = resolveModules(
    permissionKeys,
    parseModuleOverrides(process.env.NEXT_PUBLIC_MODULE_STATES),
    MODULE_CATALOGUE,
  );

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'flex h-full flex-col border-r border-border bg-card transition-[width] duration-base ease-standard',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        {/* Neutral mark and wordmark — both configuration, no brand identity committed (0028). */}
        <div className="h-6 w-6 shrink-0 rounded bg-primary" aria-hidden />
        {!collapsed && <span className="truncate text-sm font-semibold">{PRODUCT_WORDMARK}</span>}
      </div>

      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto p-2">
        {modules.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          const Icon = item.icon;
          const comingSoon = item.state === 'coming_soon';
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              data-module={item.key}
              data-state={item.state}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && (
                <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">{item.label}</span>
                  {/* Says plainly that the module is reserved rather than broken (R13). */}
                  {comingSoon && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      soon
                    </span>
                  )}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
