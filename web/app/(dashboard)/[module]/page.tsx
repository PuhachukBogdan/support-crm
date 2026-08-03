import { notFound } from 'next/navigation';
import { MODULE_CATALOGUE, parseModuleOverrides } from '@/components/shell/nav-items';

/**
 * Dynamic module route (`/contacts`, `/knowledge`, `/settings`, …).
 *
 * ── Feature 029 follow-up: the route now honours the module's STATE ─────────────────────────────
 * Roadmap 9.1's *Done when* says a hidden module has **no link and no route**, and FR-021 says a
 * "coming soon" module renders **a static screen and nothing else**. The first version of this point
 * shipped only the first half of each: the rail stopped rendering the entries, and the routes kept
 * answering. `/telephony` — the slot the operator asked us to *hide* — served a page to anyone who
 * typed the URL, and `/knowledge` served a generic "Placeholder for the Knowledge module" that reads
 * like an unfinished screen rather than a reserved one.
 *
 * ⚠️ Found by the operator clicking Knowledge Base, which is the only reason it was found at all:
 * both tests asserted the RULE (`module-states.test.tsx` on the resolver, `shell.test.tsx` on the
 * links) and neither asserted what a person reaching the URL actually gets. A rule with no consumer
 * tested is the shape of half this feature's findings.
 *
 * ⛔ **Still not enforcement.** `notFound()` here is the product saying a module is not offered; it is
 * not an access decision. Permission-gated routes are refused server-side by the owning service, and
 * roadmap 9.14 completes the picture.
 */
export default async function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;

  const overrides = parseModuleOverrides(process.env.NEXT_PUBLIC_MODULE_STATES);
  const entry = MODULE_CATALOGUE.find((m) => m.href === `/${module}`);
  const state = entry ? (overrides[entry.key] ?? entry.state) : undefined;

  // An unknown module and a hidden one are the same answer on purpose: "there is no such page here".
  // Distinguishing them would tell an unauthenticated prober which modules exist but are switched off.
  if (!entry || state === 'hidden') notFound();

  if (state === 'coming_soon') {
    return (
      <div className="mx-auto max-w-md space-y-3 py-16 text-center" data-testid="module-coming-soon">
        <h1 className="text-2xl font-semibold">{entry.label}</h1>
        {/* Says plainly that the slot is reserved, not that the screen is broken (R13/R19). */}
        <p className="text-muted-foreground">
          This module is reserved and not built yet. It will appear here when it ships — nothing is
          missing from your account.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{entry.label}</h1>
      <p className="text-muted-foreground">Placeholder for the {entry.label} module.</p>
    </div>
  );
}
