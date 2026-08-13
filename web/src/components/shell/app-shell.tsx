'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { CommandMenu } from './command-menu';
import { NavHistoryProvider } from './back';
import { useContextPanel } from './context-panel';

/**
 * The application shell (S3). Built ONCE; feature screens plug into the content slot and
 * (optionally) the right context-panel slot — they never modify the shell itself.
 *
 * ⭐ W22 (R41), kept through Шаг 1's move to the library Sidebar: the rail has ONE width and no
 * toggle. The provider is CONTROLLED — `open={false}` with a no-op setter — so every expand path
 * the library ships (Ctrl/Cmd+B, a trigger) funnels into a setter that changes nothing, and no
 * `sidebar_state` cookie is ever written. The icon width is 4rem, W22's own geometry.
 * ⓘ On mobile (<768px) the library renders the rail as a SHEET instead — opened by the Topbar's
 * `md:hidden` trigger, with full labels. That state is `openMobile`, independent of the pinned
 * desktop `open`, so the phone gets navigation without the desktop rail learning to expand.
 *
 * ⭐ W22 (R44): `NavHistoryProvider` wraps the whole shell, because "back" must work from any screen
 * and must know where the person actually came from — which no individual page can know.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const { node } = useContextPanel();

  return (
    <NavHistoryProvider>
      <SidebarProvider
        open={false}
        onOpenChange={() => {}}
        style={{ '--sidebar-width-icon': '4rem' } as CSSProperties}
        className="h-screen overflow-hidden bg-background text-foreground"
      >
        <Sidebar />

        <SidebarInset className="min-w-0">
          <Topbar onOpenCommand={() => setCommandOpen(true)} />

          <div className="flex min-h-0 flex-1">
            <main className="min-w-0 flex-1 overflow-auto p-6">{children}</main>

            {node && (
              <aside
                data-testid="context-panel"
                className="w-80 shrink-0 overflow-auto border-l border-border bg-card p-4"
              >
                {node}
              </aside>
            )}
          </div>
        </SidebarInset>

        <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
      </SidebarProvider>
    </NavHistoryProvider>
  );
}
