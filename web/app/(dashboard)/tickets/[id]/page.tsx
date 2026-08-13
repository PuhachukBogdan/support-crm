import { TicketWindow } from '@/features/ticket/ticket-window';

/**
 * The ticket window route (block W7, subpoint 2.6 — roadmap 9.3). Reached by clicking a row in the
 * Inbox; the id is the conversation id, and the server is the judge of whether the caller may read
 * it — an id typed into the URL earns exactly the same 404/refusal the API gives (no client gate).
 *
 * Two segments, so it never collides with the single-segment `[module]` catch-all.
 */
export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TicketWindow id={id} />;
}
