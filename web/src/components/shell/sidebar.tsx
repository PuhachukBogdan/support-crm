'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { MODULE_CATALOGUE, parseModuleOverrides, resolveModules } from './nav-items';
import { UserMenu } from './user-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useSession } from '@/session';

/**
 * The left rail. Colors/spacing come only from tokens (white-label).
 *
 * ── W22 (R41): icons only, ALWAYS. The expand control is gone. ───────────────────────────────────
 * The operator, looking at the shipped product: *«всегда эта боковая панель должна быть свёрнута, а у
 * нас она при старте развёрнута»*, and then the stronger half — *«какой смысл её разворачивать, если,
 * по сути, можно просто полное название впихнуть в эти всплывающие окошки. Она же только место
 * занимает на экране»*. So there is no `collapsed` prop any more and no button to press: the rail is
 * one width, and the name arrives on hover after ~0.5 s.
 *
 * ⓘ The label is the module's own `label` from the catalogue — not a second list. A rail that keeps
 * its own copy of the names is a rail that eventually disagrees with itself.
 *
 * ── The footer is new, and it is the reason this file grew (R40) ─────────────────────────────────
 * `UserMenu` (avatar + presence + profile) and a separate settings icon live at the bottom, on every
 * screen and for every role. That is where the operator put them when asked.
 *
 * ⛔ Still rendering, not enforcement: a module absent here must also have no route and no API
 * answer, which is server-side (roadmap 9.14).
 */
export function Sidebar() {
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
  // ⭐ One catalogue, two places (R40). Splitting here rather than keeping a second list is what
  // stops the footer and the nav from disagreeing about what exists.
  const navModules = modules.filter((m) => m.slot !== 'footer');
  const footerModules = modules.filter((m) => m.slot === 'footer');

  return (
    <aside
      data-testid="sidebar"
      className="flex h-full w-16 shrink-0 flex-col border-r border-border bg-card"
    >
      <div className="flex h-14 shrink-0 items-center justify-center border-b border-border">
        {/* Neutral mark — configuration, no brand identity committed (0028). */}
        <div className="h-6 w-6 rounded bg-primary" aria-hidden />
      </div>

      {/* One provider for the whole rail; 500 ms is the operator's own number («например, 0,5 секунды»). */}
      <TooltipProvider delayDuration={500}>
        <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto p-2">
          {navModules.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            const Icon = item.icon;
            const comingSoon = item.state === 'coming_soon';
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    aria-label={item.label}
                    data-module={item.key}
                    data-state={item.state}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-md transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                  </Link>
                </TooltipTrigger>
                {/* The name lives here now — that is the whole trade the operator asked for. */}
                <TooltipContent side="right" data-testid={`nav-tip-${item.key}`}>
                  {item.label}
                  {/* Says plainly that the module is reserved rather than broken (R13). */}
                  {comingSoon && <span className="ml-2 text-xs opacity-70">soon</span>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        <div className="flex shrink-0 flex-col items-center gap-1 border-t border-border p-2">
          {footerModules.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    aria-label={item.label}
                    data-module={item.key}
                    data-state={item.state}
                    data-testid={`rail-${item.key}`}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
          <UserMenu />
        </div>
      </TooltipProvider>
    </aside>
  );
}
