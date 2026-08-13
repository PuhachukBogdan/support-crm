import { TicketFields } from '@/features/ticket-fields/ticket-fields';

/**
 * ⭐ W30 (спек №1, roadmap 4.15) — ticket fields, option sets and forms as account DATA: the
 * operator re-creates his Zendesk taxonomy here himself, and no code learns a field's name.
 */
export default function AdminFieldsPage() {
  return <TicketFields />;
}
