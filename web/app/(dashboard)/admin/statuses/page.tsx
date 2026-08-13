import { Statuses } from '@/features/statuses/statuses';

/**
 * Ticket statuses (block W15a, subpoint 3.14) — the Admin Center's third real section: the nine
 * statuses, their categories, and their two names — now editable, plus creating new ones.
 */
export default function AdminStatusesPage() {
  return <Statuses />;
}
