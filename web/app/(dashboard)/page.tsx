import { Inbox } from '@/features/inbox/inbox';

/**
 * The landing route IS the Inbox (feature 029, roadmap 9.2 — FR-001).
 *
 * ⚠️ **The D2 demo dashboard that used to live here is deleted, not hidden.** It was KPI stat cards
 * over `useRecords` mock data, and the roadmap named it explicitly: *"the demo dashboard built at D2
 * is exactly the homepage this deletes"*. It was always marked disposable. Keeping it behind a flag
 * would leave two answers to "what do I see when I sign in".
 *
 * There is no intermediate page and no click: signing in lands a person on their own queue.
 */
export default function DashboardHome() {
  return <Inbox />;
}
