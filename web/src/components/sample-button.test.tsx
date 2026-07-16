import { render, screen } from '@testing-library/react';
import { SampleButton } from './sample-button';

// US3 / SC-007: FAILS if the themed sample component is absent; PASSES once it renders.
// Asserts the sample is styled via token-backed utility classes, not hardcoded color.
describe('SampleButton (themed, white-label)', () => {
  it('renders a token-styled button with no hardcoded color', () => {
    render(<SampleButton />);

    const btn = screen.getByRole('button', { name: /sample themed button/i });
    expect(btn).toBeInTheDocument();
    // Colors come from token utilities (bg-primary / text-primary-foreground)...
    expect(btn.className).toMatch(/bg-primary/);
    // ...never an inline hex color.
    expect(btn.getAttribute('style') ?? '').not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
