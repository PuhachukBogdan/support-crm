'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MODULE_CATALOGUE, parseModuleOverrides, resolveModules } from './nav-items';
import { UserMenu } from './user-menu';
import { InboxUnreadBadge } from './inbox-unread-badge';
import { useSession } from '@/session';

/**
 * The left rail — the library's Sidebar system since Шаг 1 (it was the FIRST of the four hand-made
 * nodes the registry already shipped). W22's behaviour is preserved by construction, not re-implemented:
 *
 * ── W22 (R41): icons only, ALWAYS ────────────────────────────────────────────────────────────────
 * The operator: *«какой смысл её разворачивать… она же только место занимает на экране»*. The shell's
 * `SidebarProvider` pins `open={false}` with a no-op `onOpenChange` — the CONTROLLED shape, so the
 * library's own expand paths (the Ctrl/Cmd+B shortcut, a stray `SidebarTrigger`) all funnel into a
 * setter that changes nothing. No expand control is rendered on desktop.
 *
 * ── The name arrives on hover (R41) ──────────────────────────────────────────────────────────────
 * `SidebarMenuButton`'s own tooltip machinery shows names only in the collapsed state — exactly the
 * trade the operator asked for. The provider around the menus restores HIS delay: *«например, 0,5
 * секунды»* (the library's default provider says 0).
 *
 * ⓘ The label inside the button is real markup: clipped by the icon-width rail on desktop, VISIBLE
 * in the mobile sheet — which is what makes the phone shape navigable at all (the old hand-made rail
 * simply had no mobile answer; the trigger lives in the Topbar, `md:hidden`).
 *
 * ── The footer is W22's (R40) ────────────────────────────────────────────────────────────────────
 * `UserMenu` (avatar + presence + profile) and the settings module, on every screen for every role.
 *
 * ⓘ The label is the module's own `label` from the catalogue — not a second list. A rail that keeps
 * its own copy of the names is a rail that eventually disagrees with itself.
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
    <SidebarRoot collapsible="icon" data-testid="sidebar">
      <SidebarHeader className="flex h-14 shrink-0 items-center justify-center border-b border-sidebar-border">
        {/* Neutral mark — configuration, no brand identity committed (0028). */}
        <div className="h-6 w-6 rounded bg-primary" aria-hidden />
      </SidebarHeader>

      {/* One provider for both menus; 500 ms is the operator's own number («например, 0,5 секунды»). */}
      <TooltipProvider delayDuration={500}>
        <SidebarContent>
          <nav aria-label="Main" className="p-2">
            <SidebarMenu className="gap-1">
              {navModules.map((item) => {
                const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
                const Icon = item.icon;
                const comingSoon = item.state === 'coming_soon';
                return (
                  <SidebarMenuItem key={item.key} className="flex justify-center">
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      // The name lives here now — that is the whole trade the operator asked for.
                      // «soon» says plainly the module is reserved rather than broken (R13).
                      tooltip={{
                        children: (
                          <>
                            {item.label}
                            {comingSoon && <span className="ml-2 text-xs opacity-70">soon</span>}
                          </>
                        ),
                        side: 'right',
                      }}
                      className="group-data-[collapsible=icon]:!size-10 group-data-[collapsible=icon]:justify-center"
                    >
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        aria-label={item.label}
                        data-module={item.key}
                        data-state={item.state}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {/* ⭐ W25 (R23): the unread counter, on the Inbox button and nowhere else. */}
                    {item.key === 'inbox' && <InboxUnreadBadge />}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarContent>

        <SidebarFooter className="items-center gap-1 border-t border-sidebar-border p-2">
          <SidebarMenu className="gap-1">
            {footerModules.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.key} className="flex justify-center">
                  <SidebarMenuButton
                    asChild
                    isActive={active}
                    tooltip={{ children: item.label, side: 'right' }}
                    className="group-data-[collapsible=icon]:!size-9 group-data-[collapsible=icon]:justify-center"
                  >
                    <Link
                      href={item.href}
                      aria-label={item.label}
                      data-module={item.key}
                      data-state={item.state}
                      data-testid={`rail-${item.key}`}
                    >
                      <Icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
          <UserMenu />
        </SidebarFooter>
      </TooltipProvider>
    </SidebarRoot>
  );
}
