'use client';

import { SidebarMenuBadge } from '@/components/ui/sidebar';
import { useUnseenInbox } from '@/features/inbox/use-unseen-inbox';

/**
 * ⭐ W25 (R23) — «красный овальчик с числом новых тикетов» on the Inbox button, exactly where the
 * operator put it. Renders NOTHING on the Inbox route (rule 2's visible half: while you look at the
 * list, nothing is unseen) and nothing at zero — an empty red dot would make red mean two things.
 *
 * ⓘ The library's SidebarMenuBadge hides itself in icon-collapsed mode; our rail is PERMANENTLY
 * collapsed (R41), so the display override below is load-bearing, not cosmetic. The cap at 99+ is
 * presentation — «чтобы не раздувать эту фигнюльку» — the number itself travels uncapped.
 */
export function InboxUnreadBadge() {
  const { count, onInbox } = useUnseenInbox();
  if (onInbox || count === 0) return null;
  return (
    <SidebarMenuBadge
      data-testid="inbox-unread-badge"
      className="right-0.5 top-0.5 h-4 min-w-4 rounded-full bg-destructive px-1 text-[10px] leading-none text-destructive-foreground group-data-[collapsible=icon]:flex"
    >
      {count > 99 ? '99+' : count}
    </SidebarMenuBadge>
  );
}
