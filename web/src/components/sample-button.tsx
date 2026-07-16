import { Button } from './ui/button';

// The Phase-0 themed sample (US3 / FR-011 / SC-007). Its colors come entirely from
// token-backed classes; no brand identity or hex is hardcoded. Flipping the `.dark`
// class on <html> re-themes it via token values alone.
export function SampleButton() {
  return <Button>Sample themed button</Button>;
}
