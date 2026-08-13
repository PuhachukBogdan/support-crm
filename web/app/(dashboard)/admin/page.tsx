import { ComingSoonBadge } from '@/features/inbox/coming-soon';
import { ADMIN_SECTIONS } from '@/components/shell/admin-sections';

/**
 * W13 (subpoint 3.13) — the Admin Center's reserved sections.
 *
 * ⚠️ This replaces the generic "this module is reserved" page for `/admin` with something that
 * actually answers the question a person opening it has: *what will be here?* The generic copy is
 * right for a module nobody has detailed; the admin centre has nine detailed surfaces waiting on
 * nine roadmap points, and listing them is the difference between "not built" and "not planned".
 *
 * ⛔ Nothing here is a control: no links, no buttons, nothing focusable. A reserved slot that looks
 * clickable is a control that does nothing, which is the one thing the placeholder convention
 * forbids (`coming-soon.tsx`).
 *
 * ⓘ The route's PERMISSION is still the catalogue's (`platform.role.manage`) and still server-side:
 * this page renders for whoever the shell already let through, and the day a section becomes real
 * it brings its own gate.
 */
export default function AdminCenterPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8" data-testid="admin-center">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Admin Center</h1>
          <ComingSoonBadge />
        </div>
        <p className="text-sm text-muted-foreground">
          These are the sections this centre will hold. Each is waiting on the work that fills it —
          nothing here is missing from your account, and nothing has been quietly dropped.
        </p>
      </header>

      <ul className="space-y-3">
        {ADMIN_SECTIONS.map((s) => (
          <li key={s.key} className="rounded-md border border-border p-3" data-testid={`admin-section-${s.key}`}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{s.label}</span>
              <ComingSoonBadge />
              {/* The point that owns it: a reserved slot with no owner is how a screen stays
                  reserved for ever. */}
              <span className="ml-auto text-xs text-muted-foreground">point {s.point}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{s.summary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
