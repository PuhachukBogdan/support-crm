import * as React from 'react';
import { cn } from '../../lib/utils';

// Minimal shadcn-style button. Colors resolve ONLY from token-backed utility classes
// (bg-primary, text-primary-foreground, border-border, ring-ring) — no hardcoded hex,
// so it re-themes purely via CSS variables (Principle VI / FR-011).
export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-border bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
