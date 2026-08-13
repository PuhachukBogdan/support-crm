'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * W22 — a way back from every screen (R44).
 *
 * The operator named this a key omission: *«во всех вкладках дай возможность возвращаться на
 * предыдущую вкладку. Потому что сейчас этого механизма нет, и приходится заново заходить через
 * главное меню»*.
 *
 * ── Why not the browser's back button ────────────────────────────────────────────────────────────
 * Because his complaint is about a control **on the screen**, and because the one control we do have
 * is wrong in a way that proves the point: the ticket window's «← Inbox» is hardcoded to the Inbox,
 * so a person who arrived from the customer directory is sent somewhere they were not.
 *
 * ── Why not `router.back()` ──────────────────────────────────────────────────────────────────────
 * It walks the BROWSER's history, which includes everything before the app — the login screen, or
 * whatever site the person came from. "Back" that leaves the product is not back. So this keeps its
 * own stack of in-app routes and moves inside it.
 *
 * ⛔ **No previous screen ⇒ NO CONTROL.** Not a disabled one, not one that quietly goes to `/`. A
 * control that does nothing is the exact shape this project has spent days removing (the sort arrow
 * that sorted nothing), and on navigation it is worse, because the wrong destination looks like a
 * working button.
 */
interface NavHistory {
  /** The route to return to, or `null` when this is the first screen of the session. */
  readonly previous: string | null;
  readonly goBack: () => void;
}

const Ctx = createContext<NavHistory>({ previous: null, goBack: () => {} });

export function NavHistoryProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  /**
   * ⚠️ A ref, not state: pushing a route must not re-render the whole shell. The one thing the UI
   * needs to know — "is there anywhere to go back to" — is mirrored into state deliberately, and
   * only changes when the ANSWER changes, not on every navigation.
   */
  const stack = useRef<string[]>([]);
  const [previous, setPrevious] = useState<string | null>(null);

  useEffect(() => {
    const top = stack.current[stack.current.length - 1];
    // A repeated pathname (a refresh, a replace) is not a step — otherwise "back" lands where you are.
    if (top !== pathname) stack.current.push(pathname);
    const prev = stack.current.length > 1 ? stack.current[stack.current.length - 2]! : null;
    setPrevious((was) => (was === prev ? was : prev));
  }, [pathname]);

  const goBack = useCallback(() => {
    // Pop the current entry, then go to what is under it. The effect above will not re-push it,
    // because arriving there makes it the top of the stack again.
    if (stack.current.length < 2) return;
    stack.current.pop();
    const target = stack.current[stack.current.length - 1]!;
    router.push(target);
  }, [router]);

  return <Ctx.Provider value={{ previous, goBack }}>{children}</Ctx.Provider>;
}

export function useNavHistory(): NavHistory {
  return useContext(Ctx);
}

/** The control itself. Absent — not disabled — when there is nowhere to go. */
export function BackButton() {
  const { previous, goBack } = useNavHistory();
  if (!previous) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-2 text-muted-foreground"
      data-testid="back-button"
      aria-label="Back to the previous screen"
      onClick={goBack}
    >
      <ArrowLeft className="h-4 w-4" />
      <span className="hidden sm:inline">Back</span>
    </Button>
  );
}
