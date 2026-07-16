import { render, screen, fireEvent } from '@testing-library/react';
import { StatusBadge } from './status-badge/status-badge';
import { ConfirmDialog } from './confirm-dialog/confirm-dialog';
import { ErrorState, EmptyState } from './states';
import { SidePanel } from './side-panel/side-panel';

// T025 [US5] — supporting composites render from the registry, token-driven, no inline color.

describe('supporting composites', () => {
  it('StatusBadge maps status & priority to token-driven variants (no inline color)', () => {
    const { rerender } = render(<StatusBadge kind="status" value="open" />);
    const openBadge = screen.getByText('open');
    expect(openBadge.className).toMatch(/bg-info/);
    expect(openBadge.getAttribute('style') ?? '').not.toMatch(/#|rgb\(/);

    rerender(<StatusBadge kind="priority" value="urgent" />);
    expect(screen.getByText('urgent').className).toMatch(/bg-destructive/);
  });

  it('ConfirmDialog requires an explicit confirm click', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    render(
      <ConfirmDialog
        open
        title="Delete brand?"
        description="This cannot be undone."
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('Delete brand?')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('ErrorState shows a sanitized message + retry', () => {
    const onRetry = jest.fn();
    render(<ErrorState error={{ message: 'Something went wrong.', retryable: true }} onRetry={onRetry} />);
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('EmptyState renders its title', () => {
    render(<EmptyState title="No records" description="Add one to get started" />);
    expect(screen.getByText('No records')).toBeInTheDocument();
  });

  it('SidePanel renders content when open', () => {
    render(
      <SidePanel open title="Details" onClose={() => {}}>
        <p>Panel body</p>
      </SidePanel>,
    );
    expect(screen.getByText('Panel body')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
  });
});
