import { Contacts } from '@/features/contacts/contacts';

/**
 * The customer directory (block W11, roadmap 9.17 — the list half).
 *
 * ⓘ A real route here takes precedence over the dynamic `[module]` catch-all that has been serving
 * a placeholder for `/contacts` — so the rail's existing entry stops leading to a reserved page and
 * starts leading to the screen it always named.
 */
export default function ContactsPage() {
  return <Contacts />;
}
