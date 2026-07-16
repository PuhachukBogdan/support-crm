import type { ReactNode } from 'react';

// Auth route group: no shell (no sidebar/topbar) — just a centered card region.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      {children}
    </div>
  );
}
