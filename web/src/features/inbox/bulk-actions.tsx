'use client';

import { Button } from '@/components/ui/button';
import { useSession } from '@/session';

/**
 * Bulk selection and the Actions menu (feature 029, US5 — FR-018/FR-019).
 *
 * ⛔⛔ **THIS COMPONENT IS TIDINESS, NOT ENFORCEMENT, AND THE DISTINCTION IS LOAD-BEARING.**
 *
 * Hiding the export button stops an agent tripping over a control they cannot use. It does **not**
 * stop them exporting: the server refuses `POST /exports/:scope` without `crm.exports.conversations`,
 * independently, and SEC-AP2 refuses a mass contact export **for every role including super_admin**.
 * If this component were deleted tomorrow, nothing would become permitted.
 *
 * ⚠️ That is why the permission list here comes from `/auth/me` and is used ONLY to decide what to
 * draw. A client that lies to itself about it gets refusals, not access — and the corresponding
 * Track-B scenario asserts the refusal directly rather than inferring it from the absent button.
 */
export const EXPORT_PERMISSION = 'crm.exports.conversations';

export function useMayExport(): boolean {
  const { state } = useSession();
  // Deny-by-default: any state that is not a resolved, authenticated session has no permissions.
  return state.kind === 'authenticated' && state.permissionKeys.includes(EXPORT_PERMISSION);
}

export function BulkActions({
  selectedCount,
  onExport,
}: {
  selectedCount: number;
  onExport?: () => void;
}) {
  const mayExport = useMayExport();
  if (!mayExport) return null;

  return (
    <div className="flex items-center gap-2" data-testid="inbox-bulk-actions">
      <span className="text-sm text-muted-foreground">
        {selectedCount > 0 ? `${selectedCount} selected` : 'Select rows to act on them'}
      </span>
      <Button
        variant="outline"
        size="sm"
        data-testid="inbox-export"
        disabled={selectedCount === 0}
        onClick={onExport}
      >
        Export
      </Button>
    </div>
  );
}
