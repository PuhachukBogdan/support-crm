/**
 * Shared "view-as" preview primitives (feature 011, T009). The read-only enforcement behaviour is
 * wired in US5 (gateway preview context + resolver preview branch); these are the stateless helpers
 * both tiers use so a preview can NEVER perform a write (FR-021 / SC-009).
 */

/** The minimal preview shape carried on a resolved caller (subset of EffectivePermissions). */
export interface PreviewContext {
  isPreview: boolean;
  readOnly: boolean;
}

/** Thrown when a mutating action is attempted while a read-only view-as preview is active. */
export class PreviewWriteForbiddenError extends Error {
  constructor(message = 'view-as preview is read-only') {
    super(message);
    this.name = 'PreviewWriteForbiddenError';
  }
}

/** True when the caller is inside a view-as preview. */
export function isPreview(ctx?: Partial<PreviewContext> | null): boolean {
  return !!ctx?.isPreview;
}

/** Guard a mutation path: throws {@link PreviewWriteForbiddenError} under an active read-only preview. */
export function assertNotPreviewWrite(ctx?: Partial<PreviewContext> | null): void {
  if (ctx?.isPreview || ctx?.readOnly) throw new PreviewWriteForbiddenError();
}
