'use client';

import { LogOut, PanelLeft, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useSession } from '@/session';
import { ThemeToggle } from './theme-toggle';

// Topbar: sidebar collapse toggle, a command-palette opener, the theme switch, and logout.
export function Topbar({
  onToggleSidebar,
  onOpenCommand,
}: {
  onToggleSidebar: () => void;
  onOpenCommand: () => void;
}) {
  const router = useRouter();
  const { logout } = useSession();
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Toggle sidebar"
        onClick={onToggleSidebar}
      >
        <PanelLeft className="h-4 w-4" />
      </Button>

      <div className="flex-1" />

      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={onOpenCommand}
        aria-label="Open command palette"
      >
        <Search className="h-4 w-4" />
        <span className="hidden sm:inline">Search…</span>
        <kbd className="ml-2 hidden rounded border border-border px-1 text-xs sm:inline">
          ⌘K
        </kbd>
      </Button>

      <ThemeToggle />

      <Button
        variant="ghost"
        size="icon"
        aria-label="Log out"
        onClick={() => {
          logout();
          router.push('/login');
        }}
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </header>
  );
}
