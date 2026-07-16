import { LayoutDashboard, Inbox, Users, BarChart3, Settings, type LucideIcon } from 'lucide-react';

/** Placeholder navigation for the shell. Neutral, white-label — no brand modules. */
export type NavItem = { label: string; href: string; icon: LucideIcon };

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Inbox', href: '/inbox', icon: Inbox },
  { label: 'Contacts', href: '/contacts', icon: Users },
  { label: 'Analytics', href: '/analytics', icon: BarChart3 },
  { label: 'Settings', href: '/settings', icon: Settings },
];
